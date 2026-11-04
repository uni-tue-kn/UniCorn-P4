# Tofino models

Run Tofino and BMv2 switches together and use the same resource screens for both.

## Start

From an extracted release archive, once its optional Tofino images are published:

```sh
docker compose -f docker-compose.yaml -f docker-compose.tofino.yaml pull
docker compose -f docker-compose.yaml -f docker-compose.tofino.yaml up -d
```

## Use

1. Add a **Tofino model** switch in **Topology**, connect its links, and deploy.
2. Compile your TNA program in **Editor**.
3. Select the compiled program on the switch dashboard and initialize it.

Keep sources and includes in `p4-files/` (`docker/p4-files/` in a checkout).
The model currently supports Tofino1, one pipe and up to 64 linked ports.
It simulates packet behavior, not hardware performance.

## External switches

Choose **Tofino** when adding a connection and enter its BF Runtime endpoint.
For an existing controller, enable **Read-only connection** and use an unused
client ID. Set the remote device and pipe under **Advanced connection**.
The running program is discovered automatically, with no initialization needed.
Read-only connections do not receive digest notifications.

## Source builds

For a source checkout, run `bash scripts/build-tofino.sh`, then start the built
images from `docker/` with `docker compose -f docker-compose.yaml -f
docker-compose.tofino.yaml up -d`. Builds reuse the pinned public
`n1tr0-5urf3r/open-p4studio` image, with no local SDE compilation.
