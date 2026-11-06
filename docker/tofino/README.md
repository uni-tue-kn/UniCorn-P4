# Tofino image builds

The optional SDK image is built only on the prepared VM from pinned Open
P4Studio source. GitHub Actions never recompiles Open P4Studio: it uses the
published SDK by immutable digest to build, validate, and publish the three
UniCorn Tofino images. Both model generations are smoke-tested before the SDK
or a UniCorn release is promoted:

```text
unituekn/unicornp4-tofino-sdk:tofino1-tofino2-6d8b203
```

Normal Dockerfile and Compose builds pin that publication immutably as
`unituekn/unicornp4-tofino-sdk@sha256:b6a4c770c9c483a2b125e4de4c3d32eb7d046a6e69648c534707ac7a655904a3`.
The readable tag remains the maintainer-facing publication alias.

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
The release workflow pins that digest directly. Resolve the SDK tag before a
manual application release build and compare it with the Dockerfile pin.

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

After GitHub Actions publishes the standard stable release, the optional Tofino
workflow builds the compiler, runtime, and backend as separate candidate jobs
on standard GitHub-hosted runners. It validates the native compiler and both
model generations before promoting the candidates to versioned and `latest`
Docker Hub tags. The workflow never enters the Dockerfile's SDK source-build
stage.

For a manual fallback, use a clean checkout of the release tag on this VM. Keep
Docker Hub credentials in the VM shell and resolve the public SDK to an
immutable digest:

```sh
export TAG=vMAJOR.MINOR.PATCH
export TOFINO_SDK_IMAGE="$(bash scripts/resolve-image-digest.sh \
  unituekn/unicornp4-tofino-sdk:tofino1-tofino2-6d8b203)"
release_output="$(mktemp)"
export GITHUB_OUTPUT="$release_output"
bash scripts/prepare-tofino-release.sh
export VERSION="$(sed -n 's/^version=//p' "$release_output")"
release_commit="$(sed -n 's/^commit=//p' "$release_output")"
test "$(git rev-parse HEAD)" = "$release_commit" || {
  echo "Use a clean checkout of $TAG ($release_commit)" >&2
  exit 1
}
export WORKSHOP_DIR="$PWD/.cache/tofino-rbfrt-workshop"
bash scripts/build-tofino-release.sh
bash scripts/validate-tofino-release.sh
export IMAGE_FAMILY=tofino
bash scripts/publish-images.sh
```

Do not publish manually unless native validation succeeds. The final command
pushes the three versioned images and promotes `tofino-latest`/`compiler-latest`
only when this is still the current release. The deployment archive contains a
pull-only Compose override and continues using the standard frontend image. See
[native tests](../../tests/tofino/README.md).

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

The VM source build uses the pinned Open P4Studio and p4c revisions above. Its
16-job configuration requires about 60 GiB free disk and 48 GiB RAM. Dependency
layers and compiler objects are cached. This is build headroom, not the installed
SDK size.

Checked adaptations isolate the auxiliary CLI port, enable model-only DMA
allocation without host hugepages, and limit dependency fetches to required
pinned gitlinks. The original re2 patch and its parent are fetched explicitly.
Installed artifacts remain outside the compiler-object cache.
