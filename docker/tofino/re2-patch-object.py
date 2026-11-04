"""Retain the historical patch object required by the SDK's shallow re2 clone."""
from pathlib import Path

path = Path('/opt/open-p4studio/p4studio/dependencies/source/install_grpc.py')
source = path.read_text()
old = "            execute('git cherry-pick 9bacb66 -n', grpc_repository_dir / 'third_party/re2')"
new = """            # Fetch the original upstream patch and its parent before cherry-pick.
            execute('git fetch --depth 2 origin 9bacb6659ee51dcc78d9a6e8bf4c0ae5161ea817',
                    grpc_repository_dir / 'third_party/re2')
""" + old
if source.count(old) != 1:
    raise SystemExit('Upstream re2 dependency patch changed; review its required historical object')
path.write_text(source.replace(old, new))
