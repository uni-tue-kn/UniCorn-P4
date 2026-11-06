"""Target-neutral program builds and bounded asynchronous native compilation."""
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import uuid
from urllib import error as urlerror, request as urlrequest

from flask import Blueprint, jsonify

MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_BUILD_BYTES = 128 * 1024 * 1024
_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,63}')
# Group 1 is the directive prefix and group 2 the quoted path. Shared with
# network archives so every include walker parses the same directives.
INCLUDE_PATTERN = re.compile(r'(?m)^(\s*#\s*include\s*)"([^"\n]+)"')
_ARCHITECTURE = re.compile(r'(?m)^\s*#\s*include\s*[<"](tna|t2na|v1model)\.p4[>"]')
# Quoted standard includes use the compiler's SDK search path when no local
# override exists. The backend does not mount the optional compiler's headers.
TOFINO_SYSTEM_HEADERS = frozenset({
    'core.p4', 'tna.p4', 't2na.p4',
    *('tofino' + generation + '_' + name + '.p4'
      for generation in ('1', '2') for name in ('arch', 'base', 'specs')),
    *('tofino/' + name + '.p4'
      for name in ('psa', 'wred', 'stateful_alu', 'meter', 'lpf', 'p4_14_prim', 'stratum')),
})


def sdk_header(include, candidate):
    """A quoted standard include without a local override resolves in the SDK."""
    return include in TOFINO_SYSTEM_HEADERS and not candidate.exists() and not candidate.is_symlink()


class BuildError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def program_root():
    return Path(os.environ.get('P4_DIR', '/p4')).expanduser().resolve()


def build_root():
    directory = program_root() / '.unicorn-builds'
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        raise BuildError('The build directory must be a real workspace directory')
    return directory


def contained_file(value, root=None):
    """Validate every component; artifact manifests never authorize symlink reads."""
    original_root = Path(root) if root is not None else program_root()
    root = original_root.resolve()
    if not isinstance(value, (str, Path)) or not str(value):
        raise BuildError('Select an existing program file')
    path = Path(value)
    if path.is_absolute() and original_root != root and path.is_relative_to(original_root):
        path = root / path.relative_to(original_root)
    if not path.is_absolute():
        path = root / path
    try:
        relative = path.relative_to(root)
        if any('\x00' in part for part in relative.parts):
            raise ValueError()
        current = root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise ValueError()
            if not Path(os.path.abspath(current)).is_relative_to(root):
                raise ValueError()
        if not path.is_file() or not path.resolve().is_relative_to(root):
            raise ValueError()
        return path.resolve()
    except (OSError, ValueError):
        raise BuildError('Program file is unavailable or outside the workspace') from None


def _json_file(path, maximum=MAX_ARTIFACT_BYTES):
    if path.stat().st_size > maximum:
        raise BuildError('Program metadata exceeds the supported size')
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeError):
        raise BuildError('Program metadata is not valid JSON') from None


def validate_bundle(value, root=None, verify=True):
    """Resolve a portable manifest into the absolute native adapter contract.

    Listing builds passes verify=False to skip hashing every artifact. Loading
    a build always verifies its checksums.
    """
    path = contained_file(value, root)
    metadata = _json_file(path, 1024 * 1024)
    if not isinstance(metadata, dict) or metadata.get('target') not in ('bmv2', 'tofino'):
        raise BuildError('Program build has an unsupported switch target')
    target = metadata['target']
    name = metadata.get('program_name')
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise BuildError('Program build requires a valid program name')
    for key, maximum in (('display_name', 256), ('source', 8192), ('created_at', 128)):
        if metadata.get(key) is not None and (not isinstance(metadata[key], str) or not metadata[key] or len(metadata[key]) > maximum):
            raise BuildError('Program build has invalid ' + key.replace('_', ' '))
    resolved = {**metadata, 'manifest_path': str(path)}
    checksums = metadata.get('sha256', {})
    if not isinstance(checksums, dict) or any(
            not isinstance(key, str) or not isinstance(digest, str)
            or not re.fullmatch(r'[0-9a-f]{64}', digest) for key, digest in checksums.items()):
        raise BuildError('Program build has invalid artifact checksums')
    total = 0

    def artifact(reference):
        nonlocal total
        if not isinstance(reference, str) or Path(reference).is_absolute() or '..' in Path(reference).parts:
            raise BuildError('Program artifact paths must stay inside their build')
        result = contained_file(path.parent / reference, path.parent)
        size = result.stat().st_size
        total += size
        if not size or size > MAX_ARTIFACT_BYTES or total > MAX_BUILD_BYTES:
            raise BuildError('Program artifacts are empty or exceed the supported size')
        expected = checksums.get(reference)
        if verify and expected and hashlib.sha256(result.read_bytes()).hexdigest() != expected:
            raise BuildError('Program artifact checksum does not match its build')
        return str(result)

    if target == 'bmv2':
        resolved['p4info'] = artifact(metadata.get('p4info'))
        resolved['bmv2_json'] = artifact(metadata.get('bmv2_json'))
    else:
        architecture = metadata.get('architecture', 'tofino')
        if architecture not in ('tofino', 'tofino2'):
            raise BuildError('Program build has an unsupported Tofino architecture')
        resolved['architecture'] = architecture
        resolved['bfrt_json'] = artifact(metadata.get('bfrt_json'))
        if verify:
            info = _json_file(Path(resolved['bfrt_json']))
            if not isinstance(info, dict) or not isinstance(info.get('tables'), list):
                raise BuildError('Program build has invalid resource metadata')
        profiles = metadata.get('profiles')
        if not isinstance(profiles, list) or len(profiles) != 1:
            raise BuildError('A model program must have one pipeline profile')
        resolved['profiles'] = []
        for profile in profiles:
            if (not isinstance(profile, dict) or not isinstance(profile.get('profile_name'), str)
                    or not _NAME.fullmatch(profile['profile_name'])):
                raise BuildError('Program build has an invalid pipeline profile')
            scope = profile.get('pipe_scope')
            if not isinstance(scope, list) or len(scope) != 1 or type(scope[0]) is not int or scope[0] != 0:
                raise BuildError('This model deployment requires a single pipeline instance')
            resolved['profiles'].append({**profile, 'context': artifact(profile.get('context')),
                                         'binary': artifact(profile.get('binary'))})
    return resolved


def build_description(value, verify=True):
    bundle = validate_bundle(value, verify=verify)
    source = bundle.get('source')
    name = bundle.get('display_name', bundle['program_name'])
    if source:
        source = Path(source)
        if not source.is_absolute():
            source = Path(bundle['manifest_path']).parent / source
        source = source.resolve()
        if source.is_relative_to(program_root()):
            name = source.relative_to(program_root()).with_suffix('').as_posix()
        source = str(source)
    description = {'id': bundle['manifest_path'], 'build_manifest': bundle['manifest_path'],
                   'name': name, 'target': bundle['target'], 'source': source,
                   'created_at': bundle.get('created_at')}
    if bundle['target'] == 'tofino':
        description['architecture'] = bundle.get('architecture', 'tofino')
    return description


def discover_builds():
    root = program_root()
    directory = root / '.unicorn-builds'
    builds = {}
    candidates = list(root.glob('imported-network-*/programs/switch-*/manifest.json'))
    if directory.is_dir() and not directory.is_symlink():
        candidates.extend(directory.glob('*/manifest.json'))
    for path in sorted(set(candidates)):
        try:
            program = build_description(path, verify=False)
            key = (program['target'], program.get('architecture', 'tofino'), program['source']) if program['source'] and path.is_relative_to(directory) else program['id']
            previous = builds.get(key)
            if previous is None or (program.get('created_at') or '') > (previous.get('created_at') or ''):
                builds[key] = program
        except (OSError, BuildError):
            continue
    return sorted(builds.values(), key=lambda program: (program['name'], program['id']))


def include_closure(source, strict=True):
    """Yield (path, raw, text) for a source and its quoted-include closure.

    strict=False skips includes that are missing, outside P4_DIR, symlinked
    or not UTF-8 instead of raising. Size and count limits always apply.
    """
    visited, total, pending = set(), 0, [Path(source)]
    while pending:
        try:
            path = contained_file(pending.pop())
        except BuildError:
            if strict:
                raise
            continue
        if path in visited:
            continue
        visited.add(path)
        try:
            raw = path.read_bytes()
        except OSError:
            if strict:
                raise BuildError('Program file is unavailable or outside the workspace') from None
            continue
        total += len(raw)
        if len(visited) > 128 or total > MAX_SOURCE_BYTES:
            raise BuildError('Program sources exceed the supported build size')
        try:
            text = raw.decode('utf-8')
        except UnicodeError:
            if strict:
                raise BuildError('Program sources must be UTF-8 text') from None
            continue
        yield path, raw, text
        for match in INCLUDE_PATTERN.finditer(text):
            candidate = path.parent / match.group(2)
            if not sdk_header(match.group(2), candidate):
                pending.append(candidate)


def program_architecture(source):
    """Best-effort native architecture detection; the compiler reports include errors."""
    found = set()
    try:
        for _path, _raw, text in include_closure(source, strict=False):
            text = re.sub(r'"(?:\\.|[^"\\])*"|/\*[\s\S]*?\*/|//[^\n]*',
                          lambda match: match.group(0) if match.group(0).startswith('"') else '\n' * match.group(0).count('\n'), text)
            found.update(_ARCHITECTURE.findall(text))
    except (BuildError, OSError):
        pass
    # Multi-target sources may contain both includes; explicit target selection
    # lets the compiler preprocessor choose the matching branch.
    return 'tna' if 'tna' in found else 'v1model' if 'v1model' in found else 't2na' if 't2na' in found else None


def source_target(source, requested='auto'):
    if requested not in ('auto', 'bmv2', 'tofino'):
        raise BuildError('Select a supported switch target')
    if requested == 'bmv2':
        return requested
    architecture = program_architecture(source)
    if requested == 'tofino':
        return requested
    return 'tofino' if architecture in ('tna', 't2na') else 'bmv2'


def snapshot_sources(source, destination):
    root = program_root()
    hashes = {}
    for path, raw, text in include_closure(source):
        relative = path.relative_to(root)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        hashes[relative.as_posix()] = hashlib.sha256(raw).hexdigest()

        # Absolute workspace includes must also resolve within the frozen copy.
        # Relative includes already retain their workspace directory layout.
        def frozen_include(match, target=target):
            include = match.group(2)
            if not Path(include).is_absolute():
                return match.group(0)
            included = contained_file(include)
            replacement = os.path.relpath(destination / included.relative_to(root), target.parent)
            return match.group(1) + '"' + replacement + '"'
        target.write_text(INCLUDE_PATTERN.sub(frozen_include, text), encoding='utf-8')
    return destination / Path(source).relative_to(root), hashes


# Serializes cleanup with use_build(). A build is either pinned (in use and
# not yet referenced by a state or switch) or visible to cleanup's reference
# check, never neither.
_PRUNE_LOCK = threading.Lock()
_PINNED = Counter()


@contextmanager
def use_build(value, root=None):
    """Validate a build and protect it from cleanup until the block ends.

    Hold it until the build is referenced durably, e.g. until the history
    state recording an initialization is committed.
    """
    with _PRUNE_LOCK:
        bundle = validate_bundle(value, root)
        manifest = bundle['manifest_path']
        _PINNED[manifest] += 1
    try:
        yield bundle
    finally:
        with _PRUNE_LOCK:
            _PINNED[manifest] -= 1
            if _PINNED[manifest] <= 0:
                del _PINNED[manifest]


def _created_at(metadata):
    try:
        value = datetime.fromisoformat(metadata['created_at'])
    except (KeyError, TypeError, ValueError):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def prune_builds(keep, referenced):
    """Delete unreferenced builds of the same source and target that are
    strictly older than keep. Builds without a readable age are kept.

    referenced is a callable returning the manifest paths in use. It runs
    under the cleanup lock, so it sees every reference committed by a
    use_build() block that already ended. If it fails, nothing is deleted.
    """
    try:
        directory = build_root()
    except BuildError:
        return
    with _PRUNE_LOCK:
        try:
            referenced = set(referenced()) | set(_PINNED)
            current = _json_file(keep / 'manifest.json', 1024 * 1024)
            identity, newest = (current.get('target'), current.get('architecture', 'tofino'), current.get('source')), _created_at(current)
            if newest is None or identity[2] is None:
                return
            for manifest in directory.glob('*/manifest.json'):
                build = manifest.parent
                if build == keep or build.is_symlink() or str(manifest.resolve()) in referenced:
                    continue
                try:
                    metadata = _json_file(manifest, 1024 * 1024)
                except (OSError, BuildError):
                    continue
                if not isinstance(metadata, dict) or (metadata.get('target'), metadata.get('architecture', 'tofino'), metadata.get('source')) != identity:
                    continue
                created = _created_at(metadata)
                if created is not None and created < newest:
                    shutil.rmtree(build, ignore_errors=True)
        except (OSError, BuildError):
            pass


class BuildJobs:
    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}
        # Returns the manifest paths still used by states or switches. Without
        # it, old builds are kept because pruning could break a saved state.
        self.referenced = None

    def start(self, source, architecture='tofino'):
        if architecture not in ('tofino', 'tofino2'):
            raise BuildError('Select Tofino 1 or Tofino 2 as the target architecture')
        worker = os.environ.get('TOFINO_COMPILER_URL', '').rstrip('/')
        if not worker:
            raise BuildError('The compiler for this program is unavailable in this deployment', 503)
        with self.lock:
            if any(job['status'] in ('pending', 'running') for job in self.jobs.values()):
                raise BuildError('Another program is compiling. Wait for it to finish.', 409)
            while len(self.jobs) >= 16:
                self.jobs.pop(next(iter(self.jobs)))
            identifier = uuid.uuid4().hex
            job = {'job_id': identifier, 'status': 'pending', 'target': 'tofino', 'architecture': architecture,
                   'source': str(source), 'started_at': datetime.now(timezone.utc).isoformat()}
            self.jobs[identifier] = job
        thread = threading.Thread(target=self._compile, args=(identifier, source, worker, architecture), daemon=True)
        thread.start()
        return dict(job)

    def get(self, identifier):
        with self.lock:
            if identifier not in self.jobs:
                raise BuildError('This compilation is no longer available', 404)
            return dict(self.jobs[identifier])

    def _compile(self, identifier, source, worker, architecture='tofino'):
        directory = None
        try:
            directory = build_root() / identifier
            with self.lock:
                self.jobs[identifier]['status'] = 'running'
            # Freeze quoted includes too; a host editor cannot change the build
            # halfway through a native compiler run.
            directory.mkdir(parents=True, exist_ok=False)
            frozen, hashes = snapshot_sources(source, directory / 'source')
            name = re.sub(r'[^A-Za-z0-9_]', '_', source.stem)
            if not name or name[0].isdigit():
                name = 'program_' + name
            name = name[:64]
            output = directory / 'artifacts'
            request = urlrequest.Request(worker + '/compile',
                data=json.dumps({'source': str(frozen), 'output': str(output), 'name': name, 'architecture': architecture}).encode(),
                headers={'Content-Type': 'application/json'}, method='POST')
            try:
                with urlrequest.urlopen(request, timeout=600) as response:
                    raw = response.read(MAX_SOURCE_BYTES + 1)
                if len(raw) > MAX_SOURCE_BYTES:
                    raise BuildError('Compiler response exceeds the supported size')
                data = json.loads(raw)
            except urlerror.HTTPError as error:
                try:
                    details = json.loads(error.read(8192))
                except (ValueError, UnicodeError):
                    details = {}
                raise BuildError(details.get('stderr') or details.get('error') or 'Compilation failed', error.code) from None
            if not isinstance(data, dict):
                raise BuildError('The compiler returned an invalid response')
            metadata = data.get('manifest')
            if not isinstance(metadata, dict) or metadata.get('target') != 'tofino' or metadata.get('architecture', 'tofino') != architecture:
                raise BuildError('The compiler returned an invalid program build')
            # Keep artifact references portable relative to this final manifest.
            metadata = {**metadata, 'bfrt_json': 'artifacts/' + metadata['bfrt_json'],
                        'profiles': [{**profile, 'context': 'artifacts/' + profile['context'],
                                      'binary': 'artifacts/' + profile['binary']} for profile in metadata['profiles']],
                        'source': str(source), 'source_hashes': hashes, 'display_name': source.stem,
                        'created_at': datetime.now(timezone.utc).isoformat()}
            metadata['sha256'] = {}
            for reference in [metadata['bfrt_json'], *[profile[key] for profile in metadata['profiles'] for key in ('context', 'binary')]]:
                artifact = contained_file(directory / reference, directory)
                metadata['sha256'][reference] = hashlib.sha256(artifact.read_bytes()).hexdigest()
            manifest = directory / 'manifest.json'
            manifest.write_text(json.dumps(metadata, indent=2) + '\n')
            program = build_description(manifest)
            result = {key: data.get(key, '') for key in ('command', 'stdout', 'stderr')}
            for key in ('stdout', 'stderr'):
                result[key] = str(result[key]).replace(str(directory / 'source') + os.sep, str(program_root()) + os.sep)
            result['program'] = program
            # Prune while this job still counts as running, so start() cannot
            # begin another build until cleanup has finished. A cleanup failure
            # never fails or removes this finished build.
            if self.referenced is not None:
                try:
                    prune_builds(directory, self.referenced)
                except Exception:
                    pass
            with self.lock:
                self.jobs[identifier].update(status='complete', result=result)
        except Exception as error:
            if directory is not None and not directory.parent.is_symlink():
                shutil.rmtree(directory, ignore_errors=True)
            with self.lock:
                self.jobs[identifier].update(status='failed', error=str(error)[:8192],
                    result={'stderr': str(error)[:8192], 'stdout': '', 'command': []})
        finally:
            with self.lock:
                self.jobs[identifier]['finished_at'] = datetime.now(timezone.utc).isoformat()


def register_build_routes(app):
    jobs = BuildJobs()
    app.extensions['program_builds'] = jobs
    routes = Blueprint('program_builds', __name__)

    @routes.get('/compile/jobs/<identifier>')
    def status(identifier):
        try:
            return jsonify(jobs.get(identifier))
        except BuildError as error:
            return jsonify(error=str(error)), error.status

    @routes.get('/compile/targets')
    def targets():
        available = bool(os.environ.get('TOFINO_COMPILER_URL'))
        return jsonify(targets=[{'id': 'bmv2', 'available': bool(shutil.which('p4c'))},
                               {'id': 'tofino', 'available': available}])

    app.register_blueprint(routes)
