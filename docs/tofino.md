# Tofino models

Run Tofino and BMv2 switches together and use the same resource screens for both.

## Start

From an extracted release archive, once its optional Tofino images are published:

```sh
docker compose -f docker-compose.yaml -f docker-compose.tofino.yaml pull
docker compose -f docker-compose.yaml -f docker-compose.tofino.yaml up -d
```

## Use

1. Add a **Tofino model** switch in **Topology**, choose **Tofino 1** or
   **Tofino 2**, connect its links, and deploy.
2. Compile your TNA/T2NA program in **Editor**, selecting the same generation
   explicitly or leaving target detection on **Auto**.
3. Select the compiled program on the switch dashboard and initialize it.

Keep sources and includes in `p4-files/` (`docker/p4-files/` in a checkout).
Both Tofino 1 and Tofino 2 models support one pipe and up to 64 linked ports.
They simulate packet behavior, not hardware performance.

## External switches

Choose **Tofino** when adding a connection, select the hardware generation, and
enter its BF Runtime endpoint.
For an existing controller, enable **Read-only connection** and use an unused
client ID. Set the remote device and pipe under **Advanced connection**.
The running program is discovered automatically, with no initialization needed.
Read-only connections do not receive digest notifications.

## Source builds

For a source checkout, run `bash scripts/build-tofino.sh`, then start the built
images from `docker/` with `docker compose -f docker-compose.yaml -f
docker-compose.tofino.yaml up -d`. Builds reuse the immutable dual-generation
`unituekn/unicornp4-tofino-sdk` image selected in the Tofino Dockerfile and
Compose override, with no local SDK compilation. Maintainers build and test that
SDK from the pinned Open P4Studio and p4c revisions on the prepared VM, publish
one image containing both generations, and update the default to its digest.
See `docker/tofino/README.md` for the build, test, push and digest-pinning flow.
