# P4Runtime protocol sources

`p4/config/v1/*.proto` and `p4/v1/*.proto` are the official Apache-2.0
[P4Runtime v1.6.0 release](https://github.com/p4lang/p4runtime/tree/v1.6.0/proto).
The release schema is newer than the server-advertised API version on some
BMv2 installations; the client uses stable fields shared with P4Runtime 1.3.
Resource schema presence does not establish support in the target server.

`p4/tmp/p4config.proto` and `p4/server/v1/config.proto` come from official PI
commit `701b9992ca925c90420a0cb31a4fa812f4a4f2f4`.
`p4/bm/dataplane_interface.proto` comes from the official BMv2 `1.15.7` tag.
The device wrapper's wire field numbers and types match the legacy bindings.

Install `backend/requirements-dev.txt`, then run:

```sh
python backend/controller/p4/generate.py
```

Generation is offline and uses the checked-in sources. The explicit `--fetch`
option downloads the release sources again. Generated imports are rewritten
into the `controller.p4` namespace. `google/rpc/status.proto` comes from the
pinned `googleapis-common-protos` package; well-known protobuf types come from
the pinned `grpcio-tools` package.

The auxiliary `bm/` and `server/` bindings are regenerated as well, so every
bundled module can import with the modern native protobuf runtime.
