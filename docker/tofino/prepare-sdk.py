"""Normalize a matching public SDK image for the compiler and model runtime."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

canonical = Path('/opt/open-p4studio/install')
original = Path(os.environ.get('SDE_INSTALL', str(canonical))).resolve()
source = Path(os.environ.get('SDE', str(original.parent))).resolve()
stamp = Path('/opt/unicorn/tofino/sdk-revisions.json')
expected = {'open_p4studio': os.environ['OPEN_P4STUDIO_REV'], 'p4c': os.environ['P4C_REV']}

if (source / '.git').exists():
    def git(*arguments):
        return subprocess.check_output(['git', '-C', str(source), *arguments], text=True).strip()
    actual = {'open_p4studio': git('rev-parse', 'HEAD'),
              'p4c': git('-C', str(source / 'pkgsrc/p4-compilers/p4c'), 'rev-parse', 'HEAD')}
    compiler_link = git('ls-tree', 'HEAD', 'pkgsrc/p4-compilers/p4c').split()[2]
    if compiler_link != actual['p4c']:
        raise SystemExit('Prebuilt SDK compiler does not match its official p4c submodule')
elif stamp.is_file():
    actual = json.loads(stamp.read_text())
else:
    raise SystemExit('SDK must contain its public source revision metadata or a prepared SDK revision stamp')
if actual != expected:
    raise SystemExit(f'SDK revisions {actual} differ from requested pins {expected}; pass matching source revision arguments')

for name in ('p4c', 'bf_switchd', 'tofino-model'):
    if not os.access(original / 'bin' / name, os.X_OK):
        raise SystemExit(f'Public SDK executable is missing: {original / "bin" / name}')
if original != canonical:
    canonical.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(original, canonical, dirs_exist_ok=True, symlinks=True)
alias = canonical / 'bin/bf-p4c'
alias.unlink(missing_ok=True)
alias.symlink_to('p4c')

compiler_env = dict(os.environ)
compiler_env['LD_LIBRARY_PATH'] = str(canonical / 'lib') + ':' + compiler_env.get('LD_LIBRARY_PATH', '')
compiler_version = subprocess.check_output([str(canonical / 'bin/bf-p4c'), '--version'],
                                           env=compiler_env, text=True, stderr=subprocess.STDOUT).strip()
compiler_revision = re.search(r'\bSHA:\s*([0-9a-fA-F]{7,40})\b', compiler_version)
if not compiler_revision or not expected['p4c'].startswith(compiler_revision.group(1).lower()):
    raise SystemExit(f'SDK compiler version {compiler_version!r} does not match its p4c source pin')

# A stock public SDK needs only this small simulator allocation adaptation.
# Prepared images retain the compiled library, so subsequent application builds
# neither rebuild the SDK nor need its source/compiler toolchain.
preload = canonical / 'lib/libunicorn_model_dma.so'
if not preload.is_file():
    allocator = source / 'pkgsrc/target-syslibs/src/bf_sal/linux_usr/bf_sys_dma_hugepages.c'
    if not allocator.is_file():
        raise SystemExit('Stock SDK needs its matching public SAL allocator source for model-only preparation')
    if 'UNICORN_TOFINO_MODEL_DMA' not in allocator.read_text():
        subprocess.run([sys.executable, '/tmp/model-dma.py', str(source)], check=True)
    subprocess.run(['cc', '-shared', '-fPIC', '-O2', '-I' + str(canonical / 'include'),
                    str(allocator), '-o', str(preload)], check=True)
stamp.parent.mkdir(parents=True, exist_ok=True)
stamp.write_text(json.dumps(actual, indent=2) + '\n')
print('Prepared public SDK:', json.dumps(actual), compiler_version, flush=True)
