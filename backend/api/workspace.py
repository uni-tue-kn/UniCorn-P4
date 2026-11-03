"""Bounded text-file access for the editor's configured P4 workspace."""
from contextlib import contextmanager
import errno
import hashlib
import os
from pathlib import Path
import re
import stat
import threading
import uuid


MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_FILES = 5000
LANGUAGES = {'.p4': 'p4', '.p4i': 'p4', '.h': 'cpp', '.hpp': 'cpp',
             '.json': 'json', '.txt': 'plaintext', '.txtpb': 'plaintext',
             '.md': 'markdown', '.py': 'python', '.yaml': 'yaml', '.yml': 'yaml'}
P4INFO_SUFFIXES = ('.p4info.txt', '.p4info.txtpb', '.p4info.pb.txt', '.p4info.pb')
_LOCK = threading.RLock()
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class WorkspaceError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def workspace_root():
    return Path(os.environ.get('P4_DIR', '/p4/')).expanduser().resolve()


def _parts(value):
    if not isinstance(value, str) or not value:
        raise WorkspaceError(400, 'Choose a workspace-relative file path')
    try:
        encoded = value.encode('utf-8')
    except UnicodeEncodeError:
        raise WorkspaceError(400, 'File paths must be valid UTF-8 text') from None
    if len(encoded) > 1024:
        raise WorkspaceError(400, 'Choose a workspace-relative file path')
    if value.startswith('/') or '\\' in value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise WorkspaceError(400, 'Choose a workspace-relative file path without control characters')
    parts = value.split('/')
    if any(not part or part.startswith('.') or len(part.encode('utf-8', errors='replace')) > 255 for part in parts):
        raise WorkspaceError(400, 'Hidden files and relative path components are not supported')
    if Path(parts[-1]).suffix.lower() not in LANGUAGES and not parts[-1].lower().endswith(P4INFO_SUFFIXES):
        raise WorkspaceError(400, 'Choose a supported text file such as .p4, .h, .json, .txt, .md, or .py')
    return parts


def _os_error(error):
    if isinstance(error, FileNotFoundError):
        return WorkspaceError(404, 'Workspace file was not found')
    if error.errno in (errno.ELOOP, errno.ENOTDIR):
        return WorkspaceError(400, 'Linked files and directories are not supported')
    if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return WorkspaceError(403, 'The workspace file is not writable or accessible')
    if error.errno in (errno.ENAMETOOLONG, errno.EINVAL):
        return WorkspaceError(400, 'Invalid workspace file path')
    return WorkspaceError(500, 'Could not access the workspace file')


def _preserve_owner(descriptor, reference):
    """A root-run container must not make host-owned project files root-owned."""
    current = os.fstat(descriptor)
    if (current.st_uid, current.st_gid) != (reference.st_uid, reference.st_gid):
        os.fchown(descriptor, reference.st_uid, reference.st_gid)
        # chown can clear mode bits, including a parent directory's setgid bit.
        os.fchmod(descriptor, stat.S_IMODE(current.st_mode))


def resolve_workspace_path(value, must_exist=True):
    """Resolve a relative workspace path without accepting any symlink component.

    File I/O uses directory descriptors below as well, so replacing a checked
    directory with a symlink cannot redirect a read or atomic write.
    """
    parts = _parts(value)
    target = workspace_root()
    try:
        for index, part in enumerate(parts):
            target = target / part
            try:
                mode = target.lstat().st_mode
            except FileNotFoundError:
                if must_exist:
                    raise
                continue
            if stat.S_ISLNK(mode):
                raise WorkspaceError(400, 'Linked files and directories are not supported')
            if index < len(parts) - 1 and not stat.S_ISDIR(mode):
                raise WorkspaceError(400, 'A parent path is not a directory')
        if must_exist and not target.is_file():
            raise WorkspaceError(400, 'Choose a regular workspace file')
    except OSError as error:
        raise _os_error(error) from None
    return target


@contextmanager
def _parent(value, create=False):
    parts = _parts(value)
    root = workspace_root()
    descriptor = None
    try:
        if create:
            root.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(root, _DIRECTORY_FLAGS)
        for part in parts[:-1]:
            try:
                child = os.open(part, _DIRECTORY_FLAGS, dir_fd=descriptor)
            except FileNotFoundError:
                if not create:
                    raise
                parent_info = os.fstat(descriptor)
                created = False
                try:
                    os.mkdir(part, mode=0o755, dir_fd=descriptor)
                    created = True
                except FileExistsError:
                    pass
                child = os.open(part, _DIRECTORY_FLAGS, dir_fd=descriptor)
                if created:
                    try:
                        _preserve_owner(child, parent_info)
                    except OSError:
                        os.close(child)
                        raise
            os.close(descriptor)
            descriptor = child
        yield descriptor, parts[-1], root / '/'.join(parts)
    except OSError as error:
        raise _os_error(error) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _regular(name, directory):
    try:
        return stat.S_ISREG(os.stat(name, dir_fd=directory, follow_symlinks=False).st_mode)
    except FileNotFoundError:
        return False


def _generated(name, directory):
    lowered = name.lower()
    if lowered.endswith(P4INFO_SUFFIXES) or lowered.endswith('.p4i'):
        return True
    if lowered.endswith('.json'):
        stem = name[:-5]
        return any(_regular(stem + suffix, directory) for suffix in ('.p4', *P4INFO_SUFFIXES))
    return False


def _metadata(value, target, info, directory):
    return {'path': value, 'absolute_path': str(target), 'name': target.name,
            'size': info.st_size, 'read_only': _generated(target.name, directory) or not bool(info.st_mode & 0o222),
            'language': LANGUAGES.get(target.suffix.lower(), 'plaintext')}


def _read(directory, name):
    descriptor = os.open(name, _FILE_FLAGS, dir_fd=directory)
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise WorkspaceError(400, 'Choose a regular workspace file')
        if info.st_size > MAX_FILE_BYTES:
            raise WorkspaceError(413, 'The editor supports text files up to 2 MiB')
        content = source.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise WorkspaceError(413, 'The editor supports text files up to 2 MiB')
    return content, info


def _decode(content):
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        raise WorkspaceError(400, 'The file is not valid UTF-8 text') from None
    if '\x00' in text:
        raise WorkspaceError(400, 'Binary files cannot be edited')
    return text


def _revision(content):
    return hashlib.sha256(content).hexdigest()


def list_workspace():
    root = workspace_root()
    files = []
    truncated = False
    if not root.exists():
        return {'root': str(root), 'files': [], 'max_file_bytes': MAX_FILE_BYTES, 'truncated': False}
    try:
        for directory, folders, names, descriptor in os.fwalk(root, follow_symlinks=False):
            folders[:] = sorted(name for name in folders if not name.startswith('.')
                                and name not in ('node_modules', '__pycache__', 'venv')
                                and stat.S_ISDIR(os.stat(name, dir_fd=descriptor, follow_symlinks=False).st_mode))
            for name in sorted(names):
                try:
                    relative = (Path(directory) / name).relative_to(root).as_posix()
                    _parts(relative)
                    info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode):
                        continue
                    files.append(_metadata(relative, root / relative, info, descriptor))
                except (WorkspaceError, FileNotFoundError):
                    continue
                if len(files) >= MAX_FILES:
                    truncated = True
                    break
            if truncated:
                break
    except OSError as error:
        raise _os_error(error) from None
    return {'root': str(root), 'files': sorted(files, key=lambda item: item['path']),
            'max_file_bytes': MAX_FILE_BYTES, 'truncated': truncated}


def read_workspace_file(value):
    with _parent(value) as (directory, name, target):
        content, info = _read(directory, name)
        return {**_metadata(value, target, info, directory), 'content': _decode(content), 'revision': _revision(content)}


def save_workspace_file(value, content, revision=None, create=False):
    if not isinstance(content, str) or '\x00' in content:
        raise WorkspaceError(400, 'File content must be UTF-8 text without NUL characters')
    try:
        encoded = content.encode('utf-8')
    except UnicodeEncodeError:
        raise WorkspaceError(400, 'File content must be valid UTF-8 text') from None
    if len(encoded) > MAX_FILE_BYTES:
        raise WorkspaceError(413, 'The editor supports text files up to 2 MiB')
    if create and revision is not None:
        raise WorkspaceError(400, 'New files must not specify an existing revision')
    if not create and (not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{64}', revision)):
        raise WorkspaceError(400, 'The file revision is required to avoid overwriting external edits')
    with _LOCK, _parent(value, create=create) as (directory, name, target):
        if _generated(name, directory):
            raise WorkspaceError(403, 'Generated compiler artifacts are read-only in the editor')
        old = None
        if create:
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise WorkspaceError(409, 'A file with this path already exists')
        else:
            old, old_info = _read(directory, name)
            if not old_info.st_mode & 0o222:
                raise WorkspaceError(403, 'This file is read-only')
            if _revision(old) != revision:
                raise WorkspaceError(409, 'The file changed outside this editor. Reload it before saving')
            _decode(old)
        temporary = '.unicorn-editor-' + uuid.uuid4().hex + '.tmp'
        descriptor = None
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o666, dir_fd=directory)
            _preserve_owner(descriptor, old_info if old is not None else os.fstat(directory))
            if old is not None:
                os.fchmod(descriptor, stat.S_IMODE(old_info.st_mode))
            with os.fdopen(descriptor, 'wb') as output:
                descriptor = None
                output.write(encoded)
                output.flush()
                os.fsync(output.fileno())
            if create:
                # A late competing create must never be overwritten.
                os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            else:
                try:
                    current, current_info = _read(directory, name)
                except WorkspaceError:
                    raise WorkspaceError(409, 'The file changed while saving. Reload it before saving') from None
                except FileNotFoundError:
                    raise WorkspaceError(409, 'The file was removed while saving. Reload the workspace') from None
                if (_revision(current) != revision or (current_info.st_dev, current_info.st_ino) != (old_info.st_dev, old_info.st_ino)):
                    raise WorkspaceError(409, 'The file changed while saving. Reload it before saving')
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        except FileExistsError:
            raise WorkspaceError(409, 'A file with this path already exists') from None
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
        saved = read_workspace_file(value)
        if saved['revision'] != _revision(encoded):
            # Never acknowledge an unseen external revision as the browser's
            # save: its next edit could otherwise overwrite that newer content.
            raise WorkspaceError(409, 'The file changed again after saving. Reload it before saving')
        return {**saved, 'saved': True, 'created': create}
