"""Allow the software simulator to use anonymous memory and virtual DMA tokens.

DRU simulation calls bf_mem_dma2virt to resolve every driver DMA address. Physical
contiguity and privileged pagemap lookup are only required by a hardware ASIC.
The opt-in environment variable must never be enabled for hardware switchd.
"""
from pathlib import Path
import sys
root = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/open-p4studio')
path = root / 'pkgsrc/target-syslibs/src/bf_sal/linux_usr/bf_sys_dma_hugepages.c'
source = path.read_text()
needle = 'bf_phys_addr_t bf_mem_virt2phy(const void *virtaddr) {'
assert source.count(needle) == 1
source = source.replace(needle, needle + '''
  if (getenv("UNICORN_TOFINO_MODEL_DMA"))
    return (bf_phys_addr_t)(uintptr_t)virtaddr;
''')
needle = '  if (ptr == MAP_FAILED) {\n    return NULL;\n  }'
assert source.count(needle) == 1
source = source.replace(needle, '''  if (ptr == MAP_FAILED && getenv("UNICORN_TOFINO_MODEL_DMA")) {
    ptr = (char *)mmap(NULL, actual_size, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS | MAP_POPULATE, -1, 0);
  }
''' + needle)
path.write_text(source)
