import os
from pathlib import Path

from .Endpoint import Endpoint


P4INFO_SUFFIXES = ('.p4info.txt', '.p4info.txtpb', '.p4info.pb.txt')


def _contained_file(path, root):
    """Do not advertise files reached through links outside the P4 directory."""
    try:
        return path.is_file() and path.resolve(strict=True).is_relative_to(root)
    except (OSError, RuntimeError):
        return False


# Returns possible p4info and bmv2 files in the folder for initializing
class FileNames(Endpoint):
    def get(self):
        root = Path(os.environ.get('P4_DIR', '/p4/')).expanduser().resolve()
        files = set()
        # Never descend into linked directories: a directory link may escape the
        # allowed root, or form a cycle. Linked files are checked individually.
        for directory, _, names in os.walk(root, followlinks=False):
            for name in names:
                path = Path(directory) / name
                if _contained_file(path, root):
                    files.add(path)

        # Keep the broad manual lists for older/custom compiler output names.
        p4info_files = sorted(path for path in files if path.suffix in ('.txt', '.txtpb'))
        json_files = sorted(path for path in files
                            if path.suffix == '.json' and 'topology.json' not in str(path))
        programs = []
        for bmv2 in json_files:
            candidates = [bmv2.with_name(bmv2.stem + suffix)
                          for suffix in P4INFO_SUFFIXES]
            matches = [path for path in candidates if path in files]
            if len(matches) != 1:
                continue
            source = bmv2.with_suffix('.p4')
            programs.append({
                'id': str(bmv2),
                'name': bmv2.relative_to(root).with_suffix('').as_posix(),
                'p4_info': str(matches[0]),
                'bmv2': str(bmv2),
                'source': str(source) if source in files else None,
            })
        return {'p4_info': [str(path) for path in p4info_files],
                'bmv2': [str(path) for path in json_files],
                'programs': programs}
