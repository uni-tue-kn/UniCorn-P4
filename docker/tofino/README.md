# Tofino image builds

Normal builds reuse the public SDK image:

```text
ghcr.io/n1tr0-5urf3r/open-p4studio@sha256:1431aaa7183f30191c16fda9880dc916b3e73fc2db14e93dc45177a48291412c
```

Its source pair is Open P4Studio `caf41f60aab293e32ccdb85e292433acdb1849b1`
and p4c `17ade03c106793ef0d3cd15a3f789de2760ed486` (compiler 1.2.5.4).
Preparation verifies both Git revisions, their gitlink, and the compiler binary.

From the repository root:

```sh
bash scripts/build-tofino.sh
```

This builds matching application bases and adds the SDK. Docker skips the
source-build stage. `TOFINO_SDK_IMAGE` can override the base image, but its
revisions must match the Dockerfile pins. Changing SDK versions requires
updating the matching source pins too.

| Target | Adds |
| --- | --- |
| `compiler` | P4 compilation service and built-in empty program |
| `runtime` | Model/driver and private Python libraries on the Mininet image |
| `backend` | TNA language-server headers on the standard backend |

The compiler uses shared `P4_DIR` files through a private HTTP worker. Each
model has its own namespace, working directory and control endpoint. Native
ports 0..63 correspond to topology ports 1..64, with one active pipe.
The model DMA adaptation applies only to emulated switches.

## Release images

After the standard release, dispatch **Publish optional Tofino release images**
from `main` with its stable release tag. The pinned public SDK is the default.
The workflow validates actual model packets and externs before publishing
versioned images and promoting `latest`. The deployment archive contains a
pull-only Compose override. See [native tests](../../tests/tofino/README.md).

## Optional SDK source build

Source compilation is for SDK upgrades. The separately verified newer source
pair can be built with:

```sh
docker build -f docker/tofino/Dockerfile --target sdk \
  --build-arg SDK_IMAGE=build \
  --build-arg OPEN_P4STUDIO_REV=6d8b203700e3ca0f1208418072f88dc4a6a597e8 \
  --build-arg P4C_REV=ff5070480d76cd171df54051404f118d005fbf5e \
  -t unicorn-tofino-sdk:source .
```

The **Native Tofino source validation** workflow uses that explicit source pair.
Budget 60 GiB free disk and 16 GiB RAM for clean builds. Dependency layers and
compiler objects are cached. This is build headroom, not the installed SDK size.

Checked adaptations isolate the auxiliary CLI port, enable model-only DMA
allocation without host hugepages, and limit dependency fetches to required
pinned gitlinks. The original re2 patch and its parent are fetched explicitly.
Installed artifacts remain outside the compiler-object cache.
