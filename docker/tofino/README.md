# Tofino image builds

The optional SDK image is built on the prepared VM (or by manually dispatching
the self-hosted `Build and publish dual-generation Tofino SDK` workflow) from
pinned Open P4Studio source. Ordinary GitHub CI does not perform this expensive
source build. Both Tofino model generations are smoke-tested before publishing:

```text
unituekn/unicornp4-tofino-sdk:tofino1-tofino2-6d8b203
```

Normal Dockerfile and Compose builds pin that publication immutably as
`unituekn/unicornp4-tofino-sdk@sha256:b6a4c770c9c483a2b125e4de4c3d32eb7d046a6e69648c534707ac7a655904a3`.
The readable tag remains the maintainer publication and release-workflow input.

The image includes the Tofino 1 and Tofino 2 compiler, BF Runtime, driver, and
model. It is built from Open P4Studio
`6d8b203700e3ca0f1208418072f88dc4a6a597e8` and p4c
`ff5070480d76cd171df54051404f118d005fbf5e`; the Dockerfile verifies both
revisions and their gitlink. Normal Compose builds only pull the prepared SDK.

## Build and publish on the VM

Authenticate with Docker Hub in the VM shell so credentials remain outside the
repository, then build the validation image from the pinned source pair:

```sh
docker login
docker build -f docker/tofino/Dockerfile --target compiler \
  --build-arg SDK_IMAGE=build --build-arg BUILD_JOBS=16 \
  -t unicorn-tofino-sdk-validation:local .
docker run --rm --network none --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
  --security-opt no-new-privileges:true \
  -v "$PWD/tests/tofino:/tests:ro" -v "$PWD/examples/p4/tofino:/sources:ro" \
  --entrypoint bash unicorn-tofino-sdk-validation:local /tests/run_native.sh
```

Only after both generations pass, reuse the cached source build to package and
push the single dual-generation SDK image:

```sh
tag=unituekn/unicornp4-tofino-sdk:tofino1-tofino2-6d8b203
docker build -f docker/tofino/Dockerfile --target sdk \
  --build-arg SDK_IMAGE=build --build-arg BUILD_JOBS=16 -t "$tag" .
docker push "$tag"
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag"
```

Use the printed `repository@sha256:...` reference for immutable release builds.
The optional release workflow also resolves its tag input to a digest before it
builds any release image.

From the repository root:

```sh
bash scripts/build-tofino.sh
```

This builds matching application bases and adds the SDK. Docker skips the
source-build stage. `TOFINO_SDK_IMAGE` can override the SDK image, but its
Open P4Studio and p4c revisions must match the Dockerfile pins.

| Target | Adds |
| --- | --- |
| `compiler` | P4 compilation service and built-in empty programs for both generations |
| `runtime` | Tofino 1 or Tofino 2 model/driver and private Python libraries on the Mininet image |
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
pull-only Compose override. Its frontend image is an alias of the same release's
standard UI, promoted together with the Tofino images so `latest` versions stay
aligned. See [native tests](../../tests/tofino/README.md).

## Updating SDK source pins

Source compilation is for SDK upgrades. The separately verified newer source
pair can be built with:

```sh
docker build -f docker/tofino/Dockerfile --target sdk \
  --build-arg SDK_IMAGE=build \
  --build-arg OPEN_P4STUDIO_REV=6d8b203700e3ca0f1208418072f88dc4a6a597e8 \
  --build-arg P4C_REV=ff5070480d76cd171df54051404f118d005fbf5e \
  -t unicorn-tofino-sdk:source .
```

The manual source-build workflow uses the pinned Open P4Studio and p4c revisions
above. Its 16-job configuration requires the prepared runner labelled `tofino`
with 60 GiB free disk and 48 GiB RAM. Dependency layers and compiler objects are
cached. This is build headroom, not the installed SDK size.

Checked adaptations isolate the auxiliary CLI port, enable model-only DMA
allocation without host hugepages, and limit dependency fetches to required
pinned gitlinks. The original re2 patch and its parent are fetched explicitly.
Installed artifacts remain outside the compiler-object cache.
