"""Target-neutral program builds and bounded asynchronous native compilation."""
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
_INCLUDE = re.compile(r'^\s*#\s*include\s*"([^"]+)"', re.MULTILINE)
# Quoted standard includes use the compiler's SDK search path when no local
# override exists. The backend does not mount the optional compiler's headers.
TOFINO_SYSTEM_HEADERS = frozenset({
    'core.p4', 'tna.p4', 't2na.p4',
    *('tofino' + generation + '_' + name + '.p4'
      for generation in ('1', '2') for name in ('arch', 'base', 'specs')),
    *('tofino/' + name + '.p4'
      for name in ('psa', 'wred', 'stateful_alu', 'meter', 'lpf', 'p4_14_prim', 'stratum')),
})


class BuildError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def program_root():
    return Path(os.environ.get('P4_DIR', '/p4')).expanduser().resolve()


def contained_file(value, root=None):
    """Validate every component; artifact manifests never authorize symlink reads."""
    root = root or program_root()
    if not isinstance(value, (str, Path)) or not str(value):
        raise BuildError('Select an existing program file')
    path = Path(value)
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


def validate_bundle(value, root=None):
    """Resolve a portable manifest into the absolute native adapter contract."""
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
        if expected and hashlib.sha256(result.read_bytes()).hexdigest() != expected:
            raise BuildError('Program artifact checksum does not match its build')
        return str(result)

    if target == 'bmv2':
        resolved['p4info'] = artifact(metadata.get('p4info'))
        resolved['bmv2_json'] = artifact(metadata.get('bmv2_json'))
    else:
        resolved['bfrt_json'] = artifact(metadata.get('bfrt_json'))
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


def build_description(value):
    bundle = validate_bundle(value)
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
    return {'id': bundle['manifest_path'], 'build_manifest': bundle['manifest_path'],
            'name': name, 'target': bundle['target'],
            'source': source, 'created_at': bundle.get('created_at')}


def discover_builds():
    root = program_root()
    directory = root / '.unicorn-builds'
    builds = {}
    candidates = list(root.glob('imported-network-*/programs/switch-*/manifest.json'))
    if directory.is_dir() and not directory.is_symlink():
        candidates.extend(directory.glob('*/manifest.json'))
    for path in sorted(set(candidates)):
        try:
            program = build_description(path)
            key = (program['target'], program['source']) if program['source'] and path.is_relative_to(directory) else program['id']
            previous = builds.get(key)
            if previous is None or (program.get('created_at') or '') > (previous.get('created_at') or ''):
                builds[key] = program
        except (OSError, BuildError):
            continue
    return sorted(builds.values(), key=lambda program: (program['name'], program['id']))


def source_target(source, requested='auto'):
    if requested not in ('auto', 'bmv2', 'tofino'):
        raise BuildError('Select a supported switch target')
    if requested != 'auto':
        return requested
    visited, size = set(), 0

    def inspect(path):
        nonlocal size
        path = contained_file(path)
        if path in visited:
            return False
        visited.add(path)
        if len(visited) > 128:
            raise BuildError('Program contains too many include files')
        raw = path.read_bytes()
        size += len(raw)
        if size > MAX_SOURCE_BYTES:
            raise BuildError('Program sources exceed the supported build size')
        try:
            text = raw.decode('utf-8')
        except UnicodeError:
            raise BuildError('Program sources must be UTF-8 text') from None
        if re.search(r'^\s*#\s*include\s*[<"](?:tna|t2na)\.p4[>"]', text, re.MULTILINE):
            return True
        for include in _INCLUDE.findall(text):
            candidate = path.parent / include
            if candidate.is_file() and inspect(candidate):
                return True
        return False

    return 'tofino' if inspect(source) else 'bmv2'


def snapshot_sources(source, destination):
    root = program_root()
    visited, hashes, total = set(), {}, 0

    def copy(path):
        nonlocal total
        path = contained_file(path)
        if path in visited:
            return
        visited.add(path)
        raw = path.read_bytes()
        total += len(raw)
        if len(visited) > 128 or total > MAX_SOURCE_BYTES:
            raise BuildError('Program sources exceed the supported build size')
        relative = path.relative_to(root)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        hashes[relative.as_posix()] = hashlib.sha256(raw).hexdigest()
        try:
            text = raw.decode('utf-8')
        except UnicodeError:
            raise BuildError('Program sources must be UTF-8 text') from None
        for include in _INCLUDE.findall(text):
            candidate = path.parent / include
            if include in TOFINO_SYSTEM_HEADERS and not candidate.exists() and not candidate.is_symlink():
                continue
            copy(candidate)
        # Absolute workspace includes must also resolve within the frozen copy.
        # Relative includes already retain their workspace directory layout.
        def frozen_include(match):
            include = match.group(1)
            if not Path(include).is_absolute():
                return match.group(0)
            included = contained_file(include)
            replacement = os.path.relpath(destination / included.relative_to(root), target.parent)
            return match.group(0).replace('"' + include + '"', '"' + replacement + '"')
        target.write_text(_INCLUDE.sub(frozen_include, text), encoding='utf-8')

    copy(source)
    return destination / source.relative_to(root), hashes


class BuildJobs:
    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}

    def start(self, source):
        worker = os.environ.get('TOFINO_COMPILER_URL', '').rstrip('/')
        if not worker:
            raise BuildError('The compiler for this program is unavailable in this deployment', 503)
        with self.lock:
            if any(job['status'] in ('pending', 'running') for job in self.jobs.values()):
                raise BuildError('Another program is compiling. Wait for it to finish.', 409)
            while len(self.jobs) >= 16:
                self.jobs.pop(next(iter(self.jobs)))
            identifier = uuid.uuid4().hex
            job = {'job_id': identifier, 'status': 'pending', 'target': 'tofino',
                   'source': str(source), 'started_at': datetime.now(timezone.utc).isoformat()}
            self.jobs[identifier] = job
        thread = threading.Thread(target=self._compile, args=(identifier, source, worker), daemon=True)
        thread.start()
        return dict(job)

    def get(self, identifier):
        with self.lock:
            if identifier not in self.jobs:
                raise BuildError('This compilation is no longer available', 404)
            return dict(self.jobs[identifier])

    def _compile(self, identifier, source, worker):
        directory = program_root() / '.unicorn-builds' / identifier
        try:
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
                data=json.dumps({'source': str(frozen), 'output': str(output), 'name': name}).encode(),
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
            if not isinstance(metadata, dict) or metadata.get('target') != 'tofino':
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
            with self.lock:
                self.jobs[identifier].update(status='complete', result=result)
        except Exception as error:
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
