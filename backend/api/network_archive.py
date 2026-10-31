"""Portable, bounded network snapshots. Import validation never contacts targets."""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import stat
import tempfile
import threading
import time
from urllib.request import Request, urlopen
import uuid
import zipfile

import grpc
from google.protobuf import json_format, text_format

from controller.managers.DigestManager import DigestManager
from controller.managers.QueueManager import QueueManager
from controller.p4.config.v1 import p4info_pb2
from controller.p4.tmp import p4config_pb2
from controller.p4.v1 import p4runtime_pb2 as pb
from controller.utils.helper import P4InfoHelper
from unicorn_version import local_version
from .topology_schema import validate_topology
from .endpoints.switch_config import normalize_adapter_config


FORMAT = 'unicorn-p4-network'
FORMAT_VERSION = 1
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_FILE = 32 * 1024 * 1024
MAX_FILES = 1024
MAX_ENTITIES = 100000
MAX_SWITCHES = 64
IMPORT_TTL = 1800
MAX_STAGED = 4
MAX_COMPLETED = 16
MAX_REPORT_ERRORS = 20
CATEGORIES = {
    'action_profile_members': 'action_profile_member', 'action_profile_groups': 'action_profile_group',
    'tables': 'table_entry', 'direct_meters': 'direct_meter_entry', 'direct_counters': 'direct_counter_entry',
    'registers': 'register_entry', 'counters': 'counter_entry', 'meters': 'meter_entry',
    'multicast_groups': 'packet_replication_engine_entry', 'mirrors': 'packet_replication_engine_entry',
    'digests': 'digest_entry',
}
RESTORE_ORDER = tuple(CATEGORIES)
_INCLUDE = re.compile(r'(?m)^(\s*#\s*include\s*)"([^"\n]+)"')
_STAGES = {}
_RESULTS = {}
_STAGE_LOCK = threading.RLock()
_DEPLOY_LOCK = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n').encode('utf-8')


def json_load(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError('Duplicate JSON key: ' + key)
            result[key] = value
        return result
    def invalid(value):
        raise ValueError('Non-finite JSON value: ' + value)
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def netsim_request(route, body=None, timeout=5):
    base = os.environ.get('NETSIM_URL', 'http://127.0.0.1:5001').rstrip('/')
    request = Request(base + route, data=None if body is None else json_bytes(body),
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=timeout) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('Emulator response exceeds the network archive limit')
    return json_load(raw)


def portable_topology(runtime):
    if not isinstance(runtime, dict) or not runtime.get('file_name'):
        return None
    links = []
    for link in runtime.get('links', []):
        if isinstance(link, list):
            links.append(link)
        else:
            row = [link['node1'], link['node2'], link.get('latency', '0ms')]
            if link.get('bandwidth') is not None:
                row.append(link['bandwidth'])
            links.append(row)
    interfaces = [[item['switch'], item['interface']] if isinstance(item, dict) else item
                  for item in runtime.get('ext_intfs', [])]
    return validate_topology({'hosts': runtime.get('hosts', []), 'switches': runtime.get('switches', {}),
        'links': links, 'ext_intfs': interfaces, 'layout': runtime.get('layout', {})})


def safe_config(config):
    result = {key: config.get(key) for key in ('name', 'address', 'device_id',
        'register_thrift_host', 'register_thrift_port')}
    result.update(register_adapter_enabled=config.get('register_adapter_enabled', False), proto_dump_file=None)
    return normalize_adapter_config(result)


def safe_path(name):
    if not isinstance(name, str) or len(name) > 1024 or '\\' in name or '\x00' in name:
        raise ValueError('Invalid archive path')
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(part in ('', '.', '..') for part in name.split('/')) or ':' in path.parts[0]:
        raise ValueError('Archive paths must be relative without parent traversal')
    return path.as_posix()


def source_closure(source, root, prefix, warnings):
    """Only the active source and its quoted include closure, never a directory."""
    files, pending, seen = {}, [source], set()
    initial_warnings = len(warnings)
    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        if not path.is_relative_to(root) or not path.is_file():
            warnings.append('A quoted include is unavailable or outside P4_DIR; source closure is incomplete')
            continue
        seen.add(path)
        if len(seen) > 256:
            raise ValueError('Active source include closure exceeds 256 files')
        raw = path.read_bytes()
        if len(raw) > MAX_FILE:
            raise ValueError('Active source file exceeds the archive file limit')
        text = raw.decode('utf-8')
        def include(match):
            target = (path.parent / match.group(2)).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                warnings.append(f'Quoted include {match.group(2)!r} is not portable; source closure is incomplete')
                return match.group(0)
            pending.append(target)
            # Absolute local includes must become relative for a portable tree.
            replacement = os.path.relpath(target, path.parent).replace(os.sep, '/')
            return match.group(1) + '"' + replacement + '"'
        text = _INCLUDE.sub(include, text)
        files[prefix + '/' + path.relative_to(root).as_posix()] = text.encode('utf-8')
    return files if len(warnings) == initial_warnings else {}


def active_pipeline(switch):
    request = pb.GetForwardingPipelineConfigRequest(device_id=switch.id)
    response = switch.bmv2.client_stub.GetForwardingPipelineConfig(request, timeout=30)
    if not response.config.p4info.ByteSize():
        return None
    raw = response.config.p4_device_config
    if not raw.lstrip().startswith(b'{'):
        wrapper = p4config_pb2.P4DeviceConfig.FromString(raw)
        raw = wrapper.device_data
    program = json_load(raw)
    if not isinstance(program, dict):
        raise ValueError('Target did not return a BMv2 JSON pipeline')
    return response.config.p4info, raw


def selectors(info, category):
    if category == 'tables':
        for table in info.tables:
            for default in (False, True):
                entity = pb.Entity()
                entry = entity.table_entry
                entry.table_id, entry.is_default_action = table.preamble.id, default
                entry.meter_config.SetInParent()
                entry.counter_data.SetInParent()
                yield [entity]
    elif category in ('registers', 'counters', 'meters'):
        singular = CATEGORIES[category]
        id_field = singular.removesuffix('_entry') + '_id'
        for resource in getattr(info, category):
            if resource.size > MAX_ENTITIES:
                raise ValueError(category + ' array exceeds the snapshot cell limit')
            for offset in range(0, resource.size, 128):
                batch = []
                for index in range(offset, min(resource.size, offset + 128)):
                    entity = pb.Entity()
                    entry = getattr(entity, singular)
                    setattr(entry, id_field, resource.preamble.id)
                    entry.index.index = index
                    batch.append(entity)
                yield batch
    elif category in ('direct_counters', 'direct_meters'):
        for resource in getattr(info, category):
            entity = pb.Entity()
            getattr(entity, CATEGORIES[category]).table_entry.table_id = resource.direct_table_id
            yield [entity]
    elif category == 'digests':
        for digest in info.digests:
            entity = pb.Entity()
            entity.digest_entry.digest_id = digest.preamble.id
            yield [entity]
    elif category in ('action_profile_members', 'action_profile_groups'):
        for profile in info.action_profiles:
            if category == 'action_profile_groups' and not profile.with_selector:
                continue
            entity = pb.Entity()
            getattr(entity, CATEGORIES[category]).action_profile_id = profile.preamble.id
            yield [entity]
    else:
        entity = pb.Entity()
        pre = entity.packet_replication_engine_entry
        getattr(pre, 'multicast_group_entry' if category == 'multicast_groups' else 'clone_session_entry').SetInParent()
        yield [entity]


def capture_runtime(switch, info, deadline):
    entities, categories, total = {}, {}, 0
    for category in CATEGORIES:
        rows, errors, count = [], [], 0
        try:
            for batch in selectors(info, category):
                if time.monotonic() > deadline:
                    raise TimeoutError('Live snapshot time budget exceeded')
                try:
                    for response in switch.bmv2.ReadEntities(batch):
                        for entity in response.entities:
                            if entity.WhichOneof('entity') != CATEGORIES[category]:
                                continue
                            if category in ('mirrors', 'multicast_groups') and entity.packet_replication_engine_entry.WhichOneof('type') != (
                                    'clone_session_entry' if category == 'mirrors' else 'multicast_group_entry'):
                                continue
                            if total >= MAX_ENTITIES:
                                raise ValueError('Snapshot entity limit exceeded')
                            rows.append(json_format.MessageToDict(entity, preserving_proto_field_name=True))
                            count += 1
                            total += 1
                except grpc.RpcError as error:
                    if category == 'digests' and error.code() == grpc.StatusCode.NOT_FOUND:
                        continue  # Known but disabled digest; PI has no wildcard read.
                    errors.append((error.details() or str(error.code()))[:1024])
                    if error.code() in (grpc.StatusCode.UNIMPLEMENTED, grpc.StatusCode.UNAVAILABLE):
                        break
        except Exception as error:
            errors.append(str(error)[:1024])
        entities[category] = rows
        categories[category] = {'status': 'partial' if errors and rows else 'unavailable' if errors else 'ok',
                                'count': len(rows), 'errors': errors}
    queues = QueueManager.for_switch(switch).snapshot(discover=False)
    configuration = queues['configuration']
    plan, unknown = queue_plan(configuration)
    categories['queues'] = {'status': 'ok' if plan else 'unavailable', 'count': len(plan), 'errors': [],
        'readback_available': False, 'source': 'connection_cache',
        'note': 'Acknowledged settings in this connection; unknown fields are not inferred or restored'}
    sanitize_dependencies(entities, categories, info)
    return {'entities': entities, 'queues': {'readback_available': False, 'state': queues['state'],
             'last_applied': queues['last_applied'], 'configuration': configuration,
             'unknown_fields': unknown, 'message': queues['message']}}, categories


def sanitize_dependencies(entities, categories, info):
    """Incomplete reads cannot produce an archive that pretends dependencies exist."""
    members = {(row['action_profile_member']['action_profile_id'], row['action_profile_member']['member_id'])
               for row in entities['action_profile_members']}
    def prune(category, valid, message):
        kept = []
        for row in entities[category]:
            entity = json_format.ParseDict(row, pb.Entity())
            if valid(entity):
                kept.append(row)
        omitted = len(entities[category]) - len(kept)
        if omitted:
            entities[category] = kept
            categories[category].update(status='partial', count=len(kept))
            categories[category]['errors'].append(f'{omitted} entries omitted: ' + message)
    prune('action_profile_groups', lambda entity: all((entity.action_profile_group.action_profile_id, member.member_id)
          in members for member in entity.action_profile_group.members), 'required action-profile members could not be captured')
    groups = {(row['action_profile_group']['action_profile_id'], row['action_profile_group']['group_id'])
              for row in entities['action_profile_groups']}
    profiles = {table.preamble.id: table.implementation_id for table in info.tables}
    def table_valid(entity):
        # Profiles are checked during full import validation as well. Find the
        # associated profile from the member/group ID when capture was partial.
        action = entity.table_entry.action
        kind = action.WhichOneof('type')
        if kind == 'action_profile_member_id':
            return (profiles.get(entity.table_entry.table_id), action.action_profile_member_id) in members
        if kind == 'action_profile_group_id':
            return (profiles.get(entity.table_entry.table_id), action.action_profile_group_id) in groups
        return True
    prune('tables', table_valid, 'required action-profile state could not be captured')
    keys = {table_key(json_format.ParseDict(row, pb.Entity()).table_entry) for row in entities['tables']}
    for category in ('direct_meters', 'direct_counters'):
        prune(category, lambda entity, category=category: table_key(getattr(entity, CATEGORIES[category]).table_entry) in keys,
              'parent table entry could not be captured')


def build_archive(controller, topology_file=None):
    files, warnings, switches = {}, ['Live state is a best-effort, non-atomic snapshot; traffic may change it during capture.'], []
    runtime, mappings = {}, []
    try:
        runtime = netsim_request('/topology/get')
        mappings = netsim_request('/switches/online').get('switches_online', [])
        topology = portable_topology(runtime)
    except Exception as error:
        topology = None
        warnings.append('Emulator topology could not be captured: ' + str(error)[:512])
    if topology is None and topology_file is not None:
        root = Path(os.environ.get('TOPO_DIR', '/topologies')).resolve()
        path = Path(topology_file).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Saved topology must be a known file under TOPO_DIR')
        topology = validate_topology(json_load(path.read_bytes()))
    if topology is not None:
        files['topology.json'] = json_bytes(topology)
    root = Path(os.environ.get('P4_DIR', '/p4')).resolve()
    active = list(controller.switch_configs.values())
    if len(active) > MAX_SWITCHES:
        raise ValueError('Network archive supports at most 64 active switches')
    deadline = time.monotonic() + 90
    for switch in active:
        if not switch.connected:
            continue
        config = safe_config(switch.config)
        key = 'switch-' + str(switch.id)
        mapping = next((entry for entry in mappings if entry.get('name') == config['name']
                        and entry.get('dev_id') == switch.id
                        and config.get('address') in (f"127.0.0.1:{entry.get('grpc_port')}", f"localhost:{entry.get('grpc_port')}")), None)
        record = {'key': key, 'name': config['name'], 'kind': 'emulated' if mapping is not None else 'external',
                  'config': config, 'pipeline': None, 'runtime': None, 'warnings': []}
        try:
            if time.monotonic() > deadline:
                raise TimeoutError('Live snapshot time budget exceeded')
            pipeline = active_pipeline(switch)
            if pipeline is None:
                record['warnings'].append('No active pipeline; runtime resources cannot be restored')
                switches.append(record)
                continue
            info, device = pipeline
            prefix, source = 'programs/' + key, None
            local_json = Path(switch.bmv2_file).resolve() if switch.bmv2_file else None
            if local_json is not None and local_json.is_relative_to(root) and local_json.is_file():
                candidate = local_json.with_suffix('.p4')
                if candidate.is_file() and candidate.resolve().is_relative_to(root) and json_load(local_json.read_bytes()) == json_load(device):
                    closure = source_closure(candidate, root, prefix, record['warnings'])
                    if closure:
                        source = prefix + '/' + candidate.resolve().relative_to(root).as_posix()
                        files.update(closure)
                    if candidate.stat().st_mtime > local_json.stat().st_mtime:
                        record['warnings'].append('Source is newer than the active compiled file; source and binary may differ')
            if source is None:
                record['warnings'].append('Active pipeline source is unknown; compiled pipeline is included without source')
            base = PurePosixPath(source).with_suffix('') if source else PurePosixPath(prefix + '/program')
            p4info_path, bmv2_path = str(base) + '.p4info.txt', str(base) + '.json'
            files[p4info_path] = text_format.MessageToString(info).encode('utf-8')
            files[bmv2_path] = device
            record['pipeline'] = {'p4info': p4info_path, 'bmv2': bmv2_path, 'source': source}
            state, categories = capture_runtime(switch, info, deadline)
            if state['queues']['unknown_fields']:
                record['warnings'].append('Some queue fields are unknown and will not be inferred or restored')
            state_path = 'state/' + key + '.json'
            files[state_path] = json_bytes(state)
            record['runtime'] = {'path': state_path, 'categories': categories}
            record['warnings'].extend(category + ': ' + entry['status'] for category, entry in categories.items() if entry['status'] != 'ok')
        except Exception as error:
            for name in list(files):
                if name.startswith('programs/' + key + '/') or name == 'state/' + key + '.json':
                    del files[name]
            record['pipeline'], record['runtime'] = None, None
            record['warnings'].append('Pipeline/state capture failed: ' + str(error)[:1024])
        switches.append(record)
    manifest = {'format': FORMAT, 'format_version': FORMAT_VERSION, 'version': local_version(), 'captured_at': now(),
                'topology': 'topology.json' if topology is not None else None, 'switches': switches,
                'warnings': warnings, 'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}}
    if len(files) + 1 > MAX_FILES or sum(map(len, files.values())) > MAX_TOTAL or any(len(raw) > MAX_FILE for raw in files.values()):
        raise ValueError('Network snapshot exceeds archive limits')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json_bytes(manifest))
        for name, raw in sorted(files.items()):
            archive.writestr(name, raw)
    if output.tell() > MAX_ARCHIVE:
        raise ValueError('Compressed network snapshot exceeds 64 MiB')
    output.seek(0)
    return output


def _definition(info, collection, identifier):
    found = next((item for item in getattr(info, collection) if item.preamble.id == identifier), None)
    if found is None:
        raise ValueError(f'Runtime state references an unknown {collection} ID {identifier}')
    return found


def validate_p4info(info):
    all_ids = []
    collections = ('tables', 'actions', 'action_profiles', 'counters', 'direct_counters', 'meters', 'direct_meters', 'registers', 'digests')
    for collection in collections:
        all_ids.extend(item.preamble.id for item in getattr(info, collection))
    if any(identifier == 0 for identifier in all_ids) or len(set(all_ids)) != len(all_ids):
        raise ValueError('P4Info contains zero or duplicate object IDs')
    widths = [field.bitwidth for table in info.tables for field in table.match_fields]
    widths.extend(parameter.bitwidth for action in info.actions for parameter in action.params)
    if any(not 1 <= width <= 65536 for width in widths):
        raise ValueError('P4Info match/parameter bitwidth must be within 1..65536')
    for table in info.tables:
        if len({field.id for field in table.match_fields}) != len(table.match_fields) or any(not field.id for field in table.match_fields):
            raise ValueError('P4Info table match field IDs must be nonzero and unique')
        for reference in table.action_refs:
            _definition(info, 'actions', reference.id)
        if table.implementation_id:
            _definition(info, 'action_profiles', table.implementation_id)
    for collection in ('direct_counters', 'direct_meters'):
        for resource in getattr(info, collection):
            _definition(info, 'tables', resource.direct_table_id)
    for action in info.actions:
        if len({parameter.id for parameter in action.params}) != len(action.params) or any(not parameter.id for parameter in action.params):
            raise ValueError('P4Info action parameter IDs must be nonzero and unique')
    for collection in ('registers', 'counters', 'meters'):
        if any(resource.size <= 0 for resource in getattr(info, collection)):
            raise ValueError('P4Info arrays require a positive size')


def _action(info, action):
    definition = _definition(info, 'actions', action.action_id)
    parameters = {item.id: item for item in definition.params}
    if len({item.param_id for item in action.params}) != len(action.params) or set(parameters) != {item.param_id for item in action.params}:
        raise ValueError('Action parameters do not match P4Info')
    for item in action.params:
        if not item.value or int.from_bytes(item.value, 'big') >= 1 << parameters[item.param_id].bitwidth:
            raise ValueError('Action parameter is outside its P4Info bitwidth')


def _table(info, entry, members, groups, require_action=True):
    definition = _definition(info, 'tables', entry.table_id)
    fields = {field.id: field for field in definition.match_fields}
    if entry.priority < 0 or (entry.is_default_action and entry.match):
        raise ValueError('Invalid table key priority/default action')
    seen = set()
    for match in entry.match:
        if match.field_id not in fields or match.field_id in seen:
            raise ValueError('Unknown or repeated table match field')
        seen.add(match.field_id)
        field, kind = fields[match.field_id], match.WhichOneof('field_match_type')
        expected = {2: 'exact', 3: 'lpm', 4: 'ternary', 5: 'range', 6: 'optional'}.get(field.match_type)
        if kind is None or expected != kind:
            raise ValueError('Table match type does not match P4Info')
        value = getattr(match, kind)
        values = [value.value] if kind in ('exact', 'optional', 'lpm') else [value.value, value.mask] if kind == 'ternary' else [value.low, value.high]
        if any(not raw or int.from_bytes(raw, 'big') >= 1 << field.bitwidth for raw in values):
            raise ValueError('Table match value is outside its P4Info bitwidth')
        if kind == 'lpm' and not 0 < value.prefix_len <= field.bitwidth:
            raise ValueError('Invalid LPM prefix length')
        if kind == 'lpm' and int.from_bytes(value.value, 'big') & ((1 << (field.bitwidth - value.prefix_len)) - 1):
            raise ValueError('LPM value contains nonzero bits outside its prefix')
        if kind == 'ternary' and (not int.from_bytes(value.mask, 'big') or
                int.from_bytes(value.value, 'big') & ~int.from_bytes(value.mask, 'big')):
            raise ValueError('Invalid ternary mask/value combination')
        if kind == 'range' and int.from_bytes(value.low, 'big') > int.from_bytes(value.high, 'big'):
            raise ValueError('Invalid range match')
    if not entry.is_default_action and any(field.match_type == 2 and field.id not in seen for field in definition.match_fields):
        raise ValueError('Table key is missing an exact match field')
    if require_action:
        kind = entry.action.WhichOneof('type')
        if kind == 'action':
            _action(info, entry.action.action)
            if entry.action.action.action_id not in {item.id for item in definition.action_refs}:
                raise ValueError('Table action is not declared for this table')
        elif kind == 'action_profile_member_id':
            if (definition.implementation_id, entry.action.action_profile_member_id) not in members:
                raise ValueError('Table references a missing action-profile member')
        elif kind == 'action_profile_group_id':
            if (definition.implementation_id, entry.action.action_profile_group_id) not in groups:
                raise ValueError('Table references a missing action-profile group')
        elif kind == 'action_profile_action_set':
            for item in entry.action.action_profile_action_set.action_profile_actions:
                _action(info, item.action)
                if item.weight <= 0:
                    raise ValueError('Action-profile action-set weights must be positive')
        else:
            raise ValueError('Table entry has no restorable action')
    return definition


def validate_entities(info, state):
    if not isinstance(state, dict) or not isinstance(state.get('entities'), dict) or set(state['entities']) != set(CATEGORIES):
        raise ValueError('Runtime snapshot has an invalid entity-category schema')
    entities, total = {}, 0
    for category, expected in CATEGORIES.items():
        rows = state['entities'][category]
        if not isinstance(rows, list):
            raise ValueError('Entity categories must be arrays')
        total += len(rows)
        if total > MAX_ENTITIES:
            raise ValueError('Runtime snapshot exceeds the entity limit')
        entities[category] = []
        unique = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError('Runtime entities must be protobuf JSON objects')
            try:
                entity = json_format.ParseDict(row, pb.Entity(), ignore_unknown_fields=False)
            except (ValueError, TypeError, json_format.ParseError) as error:
                raise ValueError('Invalid protobuf JSON runtime entity: ' + str(error)) from error
            if entity.WhichOneof('entity') != expected:
                raise ValueError('Runtime entity is in the wrong category')
            # Serialized payload duplicates are never legitimate snapshot rows.
            encoded = entity.SerializeToString(deterministic=True)
            if encoded in unique:
                raise ValueError('Runtime snapshot contains duplicate entities')
            unique.add(encoded)
            entities[category].append(entity)
    members, groups = set(), set()
    for entity in entities['action_profile_members']:
        item = entity.action_profile_member
        _definition(info, 'action_profiles', item.action_profile_id)
        if not item.member_id or (item.action_profile_id, item.member_id) in members:
            raise ValueError('Invalid or duplicate action-profile member ID')
        _action(info, item.action)
        members.add((item.action_profile_id, item.member_id))
    for entity in entities['action_profile_groups']:
        item = entity.action_profile_group
        profile = _definition(info, 'action_profiles', item.action_profile_id)
        if not profile.with_selector or not item.group_id or (item.action_profile_id, item.group_id) in groups:
            raise ValueError('Invalid or duplicate action-profile group ID')
        if any((item.action_profile_id, member.member_id) not in members or member.weight <= 0 for member in item.members):
            raise ValueError('Action-profile group references a missing member or invalid weight')
        groups.add((item.action_profile_id, item.group_id))
    tables = set()
    for entity in entities['tables']:
        item = entity.table_entry
        _table(info, item, members, groups)
        key = table_key(item)
        if key in tables:
            raise ValueError('Snapshot contains multiple table entries with the same key')
        tables.add(key)
    for category in ('registers', 'counters', 'meters'):
        seen = set()
        for entity in entities[category]:
            item = getattr(entity, CATEGORIES[category])
            identifier = getattr(item, CATEGORIES[category].removesuffix('_entry') + '_id')
            resource = _definition(info, category, identifier)
            if not item.HasField('index') or not 0 <= item.index.index < resource.size or (identifier, item.index.index) in seen:
                raise ValueError('Runtime array index is invalid or duplicated')
            seen.add((identifier, item.index.index))
            if category == 'registers' and not item.HasField('data'):
                raise ValueError('Register snapshot is missing its P4Data value')
            if category == 'registers':
                from controller.managers.ResourceManager import register_type
                spec = register_type(resource, info)
                if spec['kind'] in ('bit', 'int'):
                    width = spec['bitwidth']
                    if not 1 <= width <= 65536 or item.data.WhichOneof('data') != 'bitstring' or not item.data.bitstring:
                        raise ValueError('Register P4Data does not match its bitstring type')
                    value = int.from_bytes(item.data.bitstring, 'big', signed=spec['kind'] == 'int')
                    low, high = (-(1 << (width - 1)), (1 << (width - 1)) - 1) if spec['kind'] == 'int' else (0, (1 << width) - 1)
                    if not low <= value <= high:
                        raise ValueError('Register value is outside its P4Info bitwidth')
            if category == 'counters' and (item.data.byte_count < 0 or item.data.packet_count < 0):
                raise ValueError('Counter values cannot be negative')
            if category == 'meters':
                validate_meter(item)
    for category in ('direct_meters', 'direct_counters'):
        seen = set()
        valid_tables = {item.direct_table_id for item in getattr(info, category)}
        for entity in entities[category]:
            item = getattr(entity, CATEGORIES[category])
            _table(info, item.table_entry, members, groups, require_action=False)
            key = table_key(item.table_entry)
            if item.table_entry.table_id not in valid_tables or key not in tables or key in seen:
                raise ValueError('Direct resource references a missing/duplicate table entry or wrong table')
            seen.add(key)
            if category == 'direct_meters':
                validate_meter(item)
            elif item.data.byte_count < 0 or item.data.packet_count < 0:
                raise ValueError('Direct counter values cannot be negative')
    for category, field, id_field, maximum in (('multicast_groups', 'multicast_group_entry', 'multicast_group_id', 65535),
            ('mirrors', 'clone_session_entry', 'session_id', 32767)):
        seen = set()
        for entity in entities[category]:
            pre = entity.packet_replication_engine_entry
            if pre.WhichOneof('type') != field:
                raise ValueError('PRE entry is in the wrong category')
            item = getattr(pre, field)
            identifier = getattr(item, id_field)
            if not 1 <= identifier <= maximum or identifier in seen:
                raise ValueError('Invalid or duplicate PRE entry ID')
            seen.add(identifier)
            if category == 'mirrors' and (item.class_of_service > 255 or item.packet_length_bytes > 65535):
                raise ValueError('Clone-session class of service or packet length exceeds BMv2 limits')
            replicas = set()
            for replica in item.replicas:
                port = int.from_bytes(replica.port, 'big') if replica.WhichOneof('port_kind') == 'port' else replica.egress_port
                if not 1 <= port <= (1 << 32) - 1 or replica.instance > 65535 or (port, replica.instance) in replicas:
                    raise ValueError('Invalid or duplicate PRE replica')
                replicas.add((port, replica.instance))
    seen = set()
    for entity in entities['digests']:
        item = entity.digest_entry
        _definition(info, 'digests', item.digest_id)
        if item.digest_id in seen or item.config.max_timeout_ns < 0 or item.config.ack_timeout_ns < 0 or item.config.max_list_size < 0:
            raise ValueError('Invalid or duplicate digest configuration')
        seen.add(item.digest_id)
    queues = state.get('queues', {})
    if not isinstance(queues, dict) or queues.get('readback_available') is not False or not isinstance(queues.get('last_applied'), list) or len(queues['last_applied']) > 100:
        raise ValueError('Queue history must be marked as non-readback and contain at most 100 changes')
    for change in queues['last_applied']:
        if not isinstance(change, dict) or set(change) - {'port', 'depth_packets', 'rate_pps', 'applied_at'}:
            raise ValueError('Invalid queue history record')
        QueueManager.selector(change)
        from controller.managers.ResourceManager import integer
        if 'depth_packets' in change:
            integer(change['depth_packets'], 'depth_packets', minimum=1, maximum=(1 << 31) - 1)
        if 'rate_pps' in change:
            integer(change['rate_pps'], 'rate_pps', maximum=(1 << 63) - 1)
        if not {'depth_packets', 'rate_pps'} & set(change):
            raise ValueError('Queue history is missing its setting')
    queue_plan(queues.get('configuration', {'source': 'connection_cache',
        'defaults': {'depth_packets': None, 'rate_pps': None}, 'ports': []}))
    return entities


def queue_plan(configuration):
    from controller.managers.ResourceManager import integer
    if not isinstance(configuration, dict) or configuration.get('source') != 'connection_cache':
        raise ValueError('Queue configuration must be explicitly marked as connection cache, not readback')
    defaults, ports = configuration.get('defaults'), configuration.get('ports')
    if not isinstance(defaults, dict) or set(defaults) != {'depth_packets', 'rate_pps'} or not isinstance(ports, list) or len(ports) > 511:
        raise ValueError('Invalid recorded queue configuration')
    settings, unknown, seen = [], 0, set()
    for port, row in [(None, defaults)] + [(item.get('port'), item) for item in ports if isinstance(item, dict)]:
        if port is not None:
            integer(port, 'port', maximum=510)
            if port in seen:
                raise ValueError('Recorded queue ports must be unique')
            seen.add(port)
        elif row is not defaults:
            raise ValueError('Recorded port queue configuration requires a port number')
        result = {'port': port}
        for field in ('depth_packets', 'rate_pps'):
            value = row.get(field)
            if value is None:
                unknown += 1
                continue
            integer(value, field, minimum=1 if field == 'depth_packets' else 0,
                    maximum=(1 << 31) - 1 if field == 'depth_packets' else (1 << 63) - 1)
            result[field] = value
        if len(result) > 1:
            settings.append(result)
    if any(not isinstance(item, dict) for item in ports):
        raise ValueError('Recorded queue ports must be objects')
    return settings, unknown


def table_key(entry):
    key = pb.TableEntry(table_id=entry.table_id, priority=entry.priority, is_default_action=entry.is_default_action)
    for field in sorted(entry.match, key=lambda item: item.field_id):
        match = key.match.add()
        match.CopyFrom(field)
        kind = match.WhichOneof('field_match_type')
        names = ('value',) if kind in ('exact', 'optional', 'lpm') else ('value', 'mask') if kind == 'ternary' else ('low', 'high') if kind == 'range' else ()
        value = getattr(match, kind) if kind else None
        for name in names:
            setattr(value, name, getattr(value, name).lstrip(b'\x00') or b'\x00')
    return key.SerializeToString(deterministic=True)


def validate_meter(entry):
    if entry.HasField('config'):
        if any(getattr(entry.config, key) < 0 for key in ('cir', 'cburst', 'pir', 'pburst')) or entry.config.cir > entry.config.pir:
            raise ValueError('Invalid meter rate/burst configuration')


def validate_archive(raw):
    if len(raw) > MAX_ARCHIVE:
        raise ValueError('Network archive exceeds 64 MiB')
    files = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES or sum(entry.file_size for entry in entries) > MAX_TOTAL:
                raise ValueError('Network archive exceeds file-count or uncompressed-size limits')
            for entry in entries:
                name = safe_path(entry.filename)
                mode = stat.S_IFMT(entry.external_attr >> 16)
                if name in files or entry.is_dir() or mode not in (0, stat.S_IFREG) or entry.flag_bits & 1:
                    raise ValueError('Archive contains duplicate, encrypted, linked, or non-file entries')
                if entry.file_size > MAX_FILE or entry.file_size > max(1, entry.compress_size) * 2048:
                    raise ValueError('Archive member exceeds decompression limits')
                if name != 'manifest.json' and name != 'topology.json' and not name.startswith(('programs/', 'state/')):
                    raise ValueError('Unexpected file outside the network archive allowlist')
                files[name] = archive.read(entry)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as error:
        raise ValueError('Invalid or unsupported ZIP archive: ' + str(error)) from error
    if 'manifest.json' not in files:
        raise ValueError('Network archive is missing manifest.json')
    manifest = json_load(files.pop('manifest.json'))
    if not isinstance(manifest, dict) or manifest.get('format') != FORMAT or type(manifest.get('format_version')) is not int or manifest['format_version'] != FORMAT_VERSION:
        raise ValueError('Unsupported network archive format/version')
    if (not isinstance(manifest.get('version'), str) or not isinstance(manifest.get('captured_at'), str)
            or not isinstance(manifest.get('warnings'), list) or any(not isinstance(value, str) for value in manifest['warnings'])):
        raise ValueError('Manifest version, capture timestamp or warnings are invalid')
    hashes = manifest.get('files')
    if not isinstance(hashes, dict) or set(hashes) != set(files):
        raise ValueError('Manifest file list does not match the ZIP contents')
    for name, digest in hashes.items():
        if not isinstance(digest, str) or hashlib.sha256(files[name]).hexdigest() != digest:
            raise ValueError('Checksum mismatch for ' + name)
    topology = None
    if manifest.get('topology') is not None:
        if manifest['topology'] != 'topology.json' or 'topology.json' not in files:
            raise ValueError('Invalid topology reference')
        topology = validate_topology(json_load(files['topology.json']))
    records = manifest.get('switches')
    if not isinstance(records, list) or len(records) > MAX_SWITCHES:
        raise ValueError('Manifest must contain at most 64 switch records')
    keys, emulated_names, validated = set(), set(), []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('key'), str) or not re.fullmatch(r'switch-[0-9]+', record['key']) or record['key'] in keys:
            raise ValueError('Invalid or duplicate switch snapshot key')
        keys.add(record['key'])
        if not isinstance(record.get('warnings'), list) or any(not isinstance(value, str) for value in record['warnings']):
            raise ValueError('Switch warnings must be strings')
        config = record.get('config')
        if not isinstance(config, dict) or set(config) - {'name', 'address', 'device_id', 'proto_dump_file', 'register_adapter_enabled', 'register_thrift_host', 'register_thrift_port'}:
            raise ValueError('Invalid switch connection configuration')
        config = normalize_adapter_config(config)
        if config.get('proto_dump_file') is not None or record.get('name') != config['name'] or record.get('kind') not in ('emulated', 'external'):
            raise ValueError('Invalid switch name/type or unsafe protocol-log destination')
        if record['kind'] == 'emulated':
            if topology is None or record['name'] not in topology['switches'] or record['name'] in emulated_names:
                raise ValueError('Emulated switch does not match a unique topology node')
            emulated_names.add(record['name'])
        pipeline, entities, info, state = record.get('pipeline'), {}, None, None
        if pipeline is not None:
            if not isinstance(pipeline, dict) or set(pipeline) != {'p4info', 'bmv2', 'source'}:
                raise ValueError('Invalid pipeline schema')
            for field in ('p4info', 'bmv2'):
                if pipeline[field] not in files or not pipeline[field].startswith('programs/' + record['key'] + '/'):
                    raise ValueError('Pipeline is missing its referenced program file')
            info = p4info_pb2.P4Info()
            try:
                text_format.Parse(files[pipeline['p4info']].decode('utf-8'), info)
            except (ValueError, text_format.ParseError) as error:
                raise ValueError('Invalid P4Info pipeline: ' + str(error)) from error
            validate_p4info(info)
            program = json_load(files[pipeline['bmv2']])
            if not isinstance(program, dict) or any(not isinstance(program.get(key), list) for key in ('parsers', 'deparsers', 'actions', 'pipelines')):
                raise ValueError('Pipeline is not a compiled BMv2 JSON program')
            source = pipeline['source']
            if source is not None and (source not in files or not source.endswith('.p4') or not source.startswith('programs/' + record['key'] + '/')):
                raise ValueError('Invalid active source reference')
            runtime = record.get('runtime')
            if not isinstance(runtime, dict) or runtime.get('path') not in files or runtime['path'] != 'state/' + record['key'] + '.json':
                raise ValueError('Pipeline snapshot is missing its runtime-state file')
            state = json_load(files[runtime['path']])
            entities = validate_entities(info, state)
            categories = runtime.get('categories')
            if not isinstance(categories, dict) or set(categories) != set(CATEGORIES) | {'queues'}:
                raise ValueError('Runtime category status schema is invalid')
            for category, status in categories.items():
                count = len(queue_plan(state['queues']['configuration'])[0]) if category == 'queues' else len(entities[category])
                if not isinstance(status, dict) or status.get('status') not in ('ok', 'partial', 'unavailable') or status.get('count') != count or not isinstance(status.get('errors'), list) or any(not isinstance(error, str) for error in status['errors']):
                    raise ValueError('Runtime category status does not match its entities')
        elif record.get('runtime') is not None:
            raise ValueError('Runtime state cannot be restored without its pipeline')
        validated.append({'record': record, 'info': info, 'entities': entities, 'state': state})
    # Quoted source includes must stay inside the archived program closure.
    import posixpath
    compiled_files = set()
    for item in validated:
        pipeline = item['record'].get('pipeline')
        if pipeline:
            compiled_files.update(pipeline[field] for field in ('p4info', 'bmv2'))
    for name, raw_file in files.items():
        if name.startswith('programs/') and name not in compiled_files:
            try:
                text = raw_file.decode('utf-8')
            except UnicodeDecodeError as error:
                raise ValueError('P4 source/include is not UTF-8') from error
            for match in _INCLUDE.finditer(text):
                reference = posixpath.normpath(posixpath.join(posixpath.dirname(name), match.group(2)))
                if not reference.startswith('programs/') or reference not in files:
                    raise ValueError('Quoted P4 include is outside or missing from the archived source closure')
    return {'manifest': manifest, 'files': files, 'topology': topology, 'switches': validated}


def _cleanup_stages():
    expired = [token for token, stage in _STAGES.items() if stage['expires'] < time.monotonic() and not stage.get('in_use')]
    for token in expired:
        _STAGES.pop(token)['directory'].cleanup()
    for token in list(_RESULTS):
        if _RESULTS[token]['expires'] < time.monotonic():
            del _RESULTS[token]


def stage_import(raw):
    validated = validate_archive(raw)
    with _STAGE_LOCK:
        _cleanup_stages()
        if len(_STAGES) >= MAX_STAGED:
            raise ValueError('Too many staged network imports; wait for an import to expire')
        directory = tempfile.TemporaryDirectory(prefix='unicorn-network-import-')
        root = Path(directory.name)
        for name, content in validated['files'].items():
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        token = secrets.token_urlsafe(32)
        expires_at = datetime.fromtimestamp(time.time() + IMPORT_TTL, timezone.utc).isoformat()
        _STAGES[token] = dict(validated, directory=directory, expires=time.monotonic() + IMPORT_TTL,
                              expires_at=expires_at, in_use=False)
    manifest = validated['manifest']
    return {'import_token': token, 'expires_at': expires_at, 'preview': {
        'version': manifest.get('version'), 'captured_at': manifest.get('captured_at'),
        'topology': validated['topology'], 'warnings': manifest.get('warnings', []),
        'switches': [{'key': item['record']['key'], 'name': item['record']['name'], 'kind': item['record']['kind'],
            'device_id': item['record']['config']['device_id'], 'pipeline': item['info'] is not None,
            'source': (item['record'].get('pipeline') or {}).get('source'),
            'runtime': (item['record'].get('runtime') or {}).get('categories', {}),
            'warnings': item['record'].get('warnings', [])} for item in validated['switches']]}}


def deployment_options(stage, body):
    for key in ('restore_external', 'attach_external_interfaces', 'restore_queues'):
        if key in body and not isinstance(body[key], bool):
            raise ValueError(key + ' must be true or false')
    mappings = body.get('external_targets', {})
    if not isinstance(mappings, dict):
        raise ValueError('external_targets must map archived switch keys to explicit connection configurations')
    external = {item['record']['key']: item for item in stage['switches'] if item['record']['kind'] == 'external'}
    normalized, ids = {}, set()
    for key, config in mappings.items():
        if key not in external:
            raise ValueError('External target mapping references an unknown external switch')
        if not isinstance(config, dict) or not {'address', 'device_id'} <= set(config):
            raise ValueError('Each external target requires an explicit address and device_id')
        allowed = {'name', 'address', 'device_id', 'proto_dump_file', 'register_adapter_enabled', 'register_thrift_host', 'register_thrift_port'}
        if set(config) - allowed:
            raise ValueError('External target mapping contains unsupported connection settings')
        if config.get('proto_dump_file') is not None:
            raise ValueError('Imported external targets cannot choose a protocol-log destination')
        config = normalize_adapter_config(dict(config, name=config.get('name', external[key]['record']['name']), proto_dump_file=None))
        if config['device_id'] in ids:
            raise ValueError('Explicit external targets must have distinct device IDs')
        ids.add(config['device_id'])
        normalized[key] = config
    if normalized and not body.get('restore_external', False):
        raise ValueError('Set restore_external=true to use explicit external target mappings')
    return normalized


def _persist_connection(manager, config, db):
    if db is None:
        return
    from .database.SwitchConfigs import SwitchConfigs
    record = SwitchConfigs.query.filter_by(name=config['name'], address=config['address'], device_id=config['device_id']).first()
    if record is None:
        record = SwitchConfigs(**config)
        db.session.add(record)
    else:
        for field in ('register_adapter_enabled', 'register_thrift_host', 'register_thrift_port'):
            setattr(record, field, config[field])
    db.session.commit()
    manager.db_id = record.id


def _persist_pipeline(manager, controller, db, table_entities):
    if db is None:
        return
    from .database.TableStates import TableStates
    from controller.managers.TableEntry import TableEntry
    # Build fresh local history from the captured entities without an extra
    # unbounded sequence of target reads. Generic indirect actions are retained
    # in the archive even when the older MAT history renderer cannot show them.
    entries = manager.p4_helper.table_entry_blueprint()
    for entity in table_entities:
        if entity.table_entry.is_default_action or entity.table_entry.action.WhichOneof('type') != 'action':
            continue
        name = manager.p4_helper.get_tables_name(entity.table_entry.table_id)
        parsed = TableEntry(manager.p4_helper)
        parsed.from_entity(name, entity)
        entries[name].append({'id': len(entries[name]) + 1, 'switch_entry': parsed.as_json()})
    state = TableStates(p4_info_file=manager.p4_file, bmv2_file=manager.bmv2_file,
        table_entries=entries, decoding=controller.getInitialDecoding(manager.id, manager.p4_file),
        table_info=manager.p4_helper.get_table_info(), switch_config_id=manager.db_id, name='Imported network')
    db.session.add(state)
    db.session.commit()
    manager.state_id = state.id


def _restore_entity(manager, entity, category, info):
    entity = pb.Entity.FromString(entity.SerializeToString())
    kind = pb.Update.MODIFY
    if category == 'tables':
        table = entity.table_entry
        definition = _definition(info, 'tables', table.table_id)
        if table.is_const or definition.is_const_table or (table.is_default_action and definition.const_default_action_id):
            return False  # Pipeline installation already creates const entries.
        table.ClearField('time_since_last_hit')
        table.ClearField('is_const')
        kind = pb.Update.MODIFY if table.is_default_action else pb.Update.INSERT
    elif category in ('action_profile_members', 'action_profile_groups', 'multicast_groups', 'mirrors', 'digests'):
        kind = pb.Update.INSERT
    if category in ('direct_counters', 'direct_meters'):
        entry = getattr(entity, CATEGORIES[category])
        key = pb.TableEntry.FromString(table_key(entry.table_entry))
        entry.table_entry.CopyFrom(key)
    manager.bmv2.WriteEntity(entity, kind)
    return True


def restore_switch(controller, config, item, project, db, restore_queues=False, deadline=None):
    record = item['record']
    result = {'key': record['key'], 'name': config['name'], 'device_id': config['device_id'],
              'status': 'complete', 'categories': {}, 'errors': []}
    try:
        controller.addSwitchConnection(config)
        manager = controller.switch_configs[config['device_id']]
        _persist_connection(manager, config, db)
        if item['info'] is None:
            result['status'] = 'partial'
            result['errors'].append('Archived switch has no restorable pipeline')
            return result
        pipeline = record['pipeline']
        manager.initialize(str(project / pipeline['p4info']), str(project / pipeline['bmv2']), keep_entries=False)
        for category in RESTORE_ORDER:
            original = record['runtime']['categories'][category]
            status = {'status': 'complete' if original['status'] == 'ok' else 'partial', 'restored': 0,
                      'captured': len(item['entities'][category]), 'failed': 0, 'errors': []}
            for entity in item['entities'][category]:
                try:
                    if deadline is not None and time.monotonic() > deadline:
                        raise TimeoutError('Network restore time budget exceeded; remaining entries were not applied')
                    if _restore_entity(manager, entity, category, item['info']):
                        status['restored'] += 1
                except Exception as error:
                    message = error.details() if isinstance(error, grpc.RpcError) else str(error)
                    status['failed'] += 1
                    if len(status['errors']) < MAX_REPORT_ERRORS:
                        status['errors'].append((message or str(error))[:1024])
                    status['status'] = 'partial'
                    if isinstance(error, TimeoutError) or (isinstance(error, grpc.RpcError) and error.code() in (
                            grpc.StatusCode.UNIMPLEMENTED, grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED,
                            grpc.StatusCode.CANCELLED)):
                        break
            result['categories'][category] = status
            if status['status'] != 'complete':
                result['status'] = 'partial'
        queue_settings, unknown = queue_plan(item['state']['queues']['configuration'])
        if queue_settings:
            if restore_queues:
                restored, errors = 0, []
                for change in queue_settings:
                    try:
                        if deadline is not None and time.monotonic() > deadline:
                            raise TimeoutError('Network restore time budget exceeded; remaining queue settings were not applied')
                        QueueManager.for_switch(manager).write({key: value for key, value in change.items()
                            if key in ('port', 'depth_packets', 'rate_pps')})
                        restored += 1
                    except Exception as error:
                        errors.append(str(error)[:1024])
                        break
                result['categories']['queues'] = {'status': 'complete' if not errors else 'partial',
                    'restored': restored, 'errors': errors, 'readback_available': False, 'unknown_fields_skipped': unknown,
                    'note': 'Restored acknowledged configuration from the previous connection, not switch readback'}
                if errors:
                    result['status'] = 'partial'
            else:
                result['categories']['queues'] = {'status': 'skipped', 'restored': 0, 'readback_available': False,
                    'note': 'Only historical acknowledged settings were captured; queue replay was not requested'}
        _persist_pipeline(manager, controller, db, item['entities']['tables'])
    except Exception as error:
        if db is not None:
            db.session.rollback()
        result['status'] = 'partial'
        result['errors'].append(str(error)[:1024])
    return result


def deploy_import(controller, db, body):
    if not isinstance(body, dict) or not isinstance(body.get('import_token'), str):
        raise ValueError('import_token is required')
    with _STAGE_LOCK:
        _cleanup_stages()
        cached = _RESULTS.get(body['import_token'])
        if cached is not None:
            return cached['result']  # No staged files or target contact on retry.
        stage = _STAGES.get(body['import_token'])
        if stage is None:
            raise KeyError('Import token is unknown or expired; import the archive again')
        external = deployment_options(stage, body)
        if stage['in_use']:
            raise RuntimeError('This network import is already deploying')
        stage['in_use'] = True
    if not _DEPLOY_LOCK.acquire(blocking=False):
        with _STAGE_LOCK:
            stage['in_use'] = False
        raise RuntimeError('Another network import is already deploying')
    result = {'status': 'complete', 'topology': None, 'switches': [], 'warnings': [],
              'imported_project': None, 'topology_file': None}
    deadline = time.monotonic() + 240
    try:
        # Revalidate staged file bytes, not just the initial in-memory result.
        # A token only authorizes this validated bundle, never arbitrary paths.
        root = Path(stage['directory'].name)
        for name, digest in stage['manifest']['files'].items():
            path = root / name
            if not path.is_file() or path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('Staged import changed after validation')
        identifier = 'imported-network-' + uuid.uuid4().hex
        p4root = Path(os.environ.get('P4_DIR', '/p4')).resolve()
        p4root.mkdir(parents=True, exist_ok=True)
        project = p4root / identifier
        project.mkdir(mode=0o700)
        for name in stage['files']:
            if not name.startswith('programs/'):
                continue
            target = project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, target)
        result['imported_project'] = str(project)
        topology = json_load(json_bytes(stage['topology'])) if stage['topology'] is not None else None
        if topology is not None:
            if topology.get('ext_intfs') and not body.get('attach_external_interfaces', False):
                topology['ext_intfs'] = []
                result['warnings'].append('Physical interface attachments were retained in the archive but omitted during this deployment')
            topo_root = Path(os.environ.get('TOPO_DIR', '/topologies')).resolve()
            topo_root.mkdir(parents=True, exist_ok=True)
            topology_path = topo_root / (identifier + '.json')
            with topology_path.open('x', encoding='utf-8') as destination:
                json.dump(topology, destination, indent=2, allow_nan=False)
            result['topology_file'] = str(topology_path)
        # The caller confirms replacement in the UI. Close existing streams
        # before Mininet replaces the topology and assigns actual IDs/ports.
        if topology is not None or external:
            controller.deleteAllSwitchConnections()
        mappings = []
        if topology is not None:
            loaded = netsim_request('/topology/load', {'topology_file': result['topology_file']}, timeout=60)
            if not isinstance(loaded, dict) or not loaded.get('file_name'):
                raise ValueError('Emulator did not return a loaded topology')
            result['topology'] = loaded
            mappings = loaded.get('switches_online')
            if not isinstance(mappings, list):
                mappings = netsim_request('/switches/online').get('switches_online', [])
        by_name = {entry['name']: entry for entry in mappings}
        used = set()
        for item in stage['switches']:
            record, config = item['record'], None
            if time.monotonic() > deadline:
                result['switches'].append({'key': record['key'], 'name': record['name'], 'status': 'partial',
                    'categories': {}, 'errors': ['Network restore time budget exceeded; switch was not contacted']})
                result['status'] = 'partial'
                continue
            if record['kind'] == 'emulated':
                mapping = by_name.get(record['name'])
                if mapping is not None:
                    config = normalize_adapter_config({'name': record['name'], 'address': '127.0.0.1:' + str(mapping['grpc_port']),
                        'device_id': mapping['dev_id'], 'proto_dump_file': None, 'register_adapter_enabled': False,
                        'register_thrift_host': '127.0.0.1', 'register_thrift_port': mapping.get('thrift_port')})
                else:
                    result['switches'].append({'key': record['key'], 'name': record['name'], 'status': 'partial',
                        'categories': {}, 'errors': ['Emulated switch was not discovered after deployment']})
                    result['status'] = 'partial'
                    continue
            elif body.get('restore_external') and record['key'] in external:
                config = external[record['key']]
            else:
                result['switches'].append({'key': record['key'], 'name': record['name'], 'status': 'skipped',
                    'categories': {}, 'errors': [], 'note': 'External target requires an explicit destination mapping'})
                result['warnings'].append('Skipped external switch ' + record['name'] + '; archived addresses were not contacted')
                continue
            if config['device_id'] in used:
                result['switches'].append({'key': record['key'], 'name': config['name'], 'status': 'partial',
                    'categories': {}, 'errors': ['Destination device ID conflicts with another restored switch']})
                result['status'] = 'partial'
                continue
            used.add(config['device_id'])
            restored = restore_switch(controller, config, item, project, db, body.get('restore_queues', False), deadline)
            result['switches'].append(restored)
            if restored['status'] != 'complete':
                result['status'] = 'partial'
        for item in stage['switches']:
            result['warnings'].extend(item['record'].get('warnings', []))
        if result['warnings']:
            # Warnings do not mean fabricated/missing state was restored.
            result['status'] = 'partial'
    except Exception as error:
        result['status'] = 'partial'
        result['error'] = str(error)[:2048]
    finally:
        _DEPLOY_LOCK.release()
        with _STAGE_LOCK:
            # Payload capacity is for pending imports. Keep only a small result
            # cache after deployment so sequential imports do not fill it up.
            _STAGES.pop(body['import_token'], None)
            stage['directory'].cleanup()
            stage.clear()
            _RESULTS[body['import_token']] = {'result': result, 'expires': time.monotonic() + IMPORT_TTL}
            while len(_RESULTS) > MAX_COMPLETED:
                del _RESULTS[next(iter(_RESULTS))]
    return result
