# Target compatibility

| Target | Registers | Connection |
| --- | --- | --- |
| Included BMv2 | `bit<W>` and `int<W>`, 1–64 bits | The emulator enables its P4Runtime register adapter automatically. |
| External stock BMv2/PI | 1–63 bits with the explicit register adapter | Supply its P4Runtime endpoint and, for registers or queues, its Thrift endpoint. |
| Tofino | Native scalar and structured registers | Use BF Runtime. Models require the optional Tofino Compose file. |

Stock BMv2/PI does not implement P4Runtime register access itself. Wider or
structured BMv2 registers are unsupported. Register arrays are read cell by cell,
so traffic can change values during a refresh or export.

BMv2 queue depth and rate have setters without getters. The UI shows settings
acknowledged during the current connection. Changes from another controller
cannot be detected.

Tofino models support Tofino1, one pipe and up to 64 linked ports. They simulate
packet behavior, not hardware throughput. External read-only Tofino connections
discover the running program without taking ownership, but do not receive digests.

Resource availability follows the loaded P4 program and target. Component
versions are shown in the UI. See [usage](usage.md) and [Tofino setup](tofino.md).
