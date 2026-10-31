import json
import os
from pathlib import Path
import re
import tempfile

from flask import request

from ..topology_schema import validate_topology
from .Endpoint import Endpoint


class Topologies(Endpoint):
    def get(self):
        root = Path(os.environ.get('TOPO_DIR', '/topologies')).resolve()
        files = sorted(str(path) for path in root.rglob('*.json')
                       if path.is_file() and path.resolve().is_relative_to(root))
        name = request.args.get('name')
        if name is None:
            return {'topologies': files}
        if name not in files:
            return {'error': 'Unknown saved topology'}, 404
        try:
            return {name: json.loads(Path(name).read_text(encoding='utf-8'))}
        except (OSError, ValueError):
            return {'error': 'Could not read the saved topology'}, 400

    def post(self):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return {'error': 'A JSON topology draft is required'}, 400
        name = body.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,123}(?:\.json)?', name) or '..' in name:
            return {'error': 'Use a simple topology filename without directories'}, 400
        if not name.endswith('.json'):
            name += '.json'
        overwrite = body.get('overwrite', False)
        if not isinstance(overwrite, bool):
            return {'error': 'overwrite must be true or false'}, 400
        try:
            topology = validate_topology(body.get('topology'))
            root = Path(os.environ.get('TOPO_DIR', '/topologies')).resolve()
            root.mkdir(parents=True, exist_ok=True)
            target = root / name
            if target.is_symlink() or target.resolve().parent != root:
                return {'error': 'Invalid topology destination'}, 400
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=root, prefix='.topology-', delete=False) as temporary:
                temporary_path = Path(temporary.name)
                try:
                    json.dump(topology, temporary, indent=2, allow_nan=False)
                    temporary.write('\n')
                    temporary.flush()
                    os.fsync(temporary.fileno())
                    if overwrite:
                        os.replace(temporary_path, target)
                    else:
                        os.link(temporary_path, target)
                finally:
                    temporary_path.unlink(missing_ok=True)
            return {'name': str(target), 'topology': topology, 'saved': True}, 200
        except FileExistsError:
            return {'error': 'A topology with this filename already exists; choose another name or enable overwrite'}, 409
        except (ValueError, TypeError) as error:
            return {'error': str(error)}, 400
        except OSError:
            return {'error': 'Could not save the topology file'}, 500
