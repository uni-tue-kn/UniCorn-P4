# Official BMv2 Thrift client

`standard.thrift` is copied without modification from official BMv2 1.15.7,
commit `596af92b7e397734fa09959f8a91e6e01f4baa1e`, under Apache-2.0 (see LICENSE).
The Python files are generated with the official Apache Thrift compiler 0.17.0:

```sh
thrift --gen py -out /tmp/bmv2-thrift standard.thrift
```

The backend and emulator use the Python Thrift runtime 0.25.0 for security fixes.
The native BMv2 server and generated service definitions retain their existing
versions. Register access and queue controls use buffered, multiplexed binary RPCs.
The runtime's default string/binary field limit of 16,384,000 bytes remains
enabled, including for a switch's JSON configuration returned by `bm_get_config`.

Only `bm_runtime/standard/{Standard,ttypes,constants}.py` is needed. Generated
imports are relative, so they work directly under `runtime.thrift.bm_runtime`.
This bundled client avoids depending on a native BMv2 installation on the web
backend. It is used only when the user explicitly enables an external adapter
or by the emulator's bundled P4Runtime extension.

`simple_switch.thrift` and `sswitch_runtime/{SimpleSwitch,ttypes,constants}.py`
come from the same pinned official BMv2 source/compiler. The target-specific
client uses the `simple_switch` multiplexed service. Queue depth/rate setters
are native BMv2 controls; they have no standard P4Runtime representation and
no getter in this API. The web UI reports only acknowledged settings applied
during its current switch connection.
