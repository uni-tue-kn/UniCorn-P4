# Optional model/compiler images reuse the pinned public SDK by default.
ARG SDK_IMAGE=ghcr.io/n1tr0-5urf3r/open-p4studio@sha256:1431aaa7183f30191c16fda9880dc916b3e73fc2db14e93dc45177a48291412c
ARG NETSIM_IMAGE=unicornp4-netsim:local
ARG BACKEND_IMAGE=unicornp4-backend:local
ARG OPEN_P4STUDIO_REV=caf41f60aab293e32ccdb85e292433acdb1849b1
ARG P4C_REV=17ade03c106793ef0d3cd15a3f789de2760ed486
FROM ubuntu:22.04 AS build
ARG OPEN_P4STUDIO_REV
ARG P4C_REV
ARG BUILD_JOBS=2
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends sudo python3 python3-pip \
    build-essential cmake ca-certificates git libssl-dev iproute2 ethtool tcpdump \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/open-p4studio
RUN git init && git remote add origin https://github.com/p4lang/open-p4studio.git \
    && git fetch --depth 1 origin ${OPEN_P4STUDIO_REV} && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${OPEN_P4STUDIO_REV}" \
    && test "$(git ls-tree HEAD pkgsrc/p4-compilers/p4c | awk '{print $3}')" = "${P4C_REV}" \
    && git submodule update --init --recursive --depth 1
COPY docker/tofino/profile.yaml /tmp/unicorn-profile.yaml
COPY docker/tofino/patch-upstream.py /tmp/patch-upstream.py
COPY docker/tofino/model-dma.py /tmp/model-dma.py
RUN python3 /tmp/patch-upstream.py && python3 /tmp/model-dma.py \
    && test "${BUILD_JOBS}" -ge 1 && test "${BUILD_JOBS}" -le 2 \
    && python3 ./p4studio dependencies install --jobs ${BUILD_JOBS} --types os,pip
# Keep successful dependency work when a later fetch or native compile fails.
# These are the source packages selected by the fixed profile.yaml above.
RUN python3 ./p4studio dependencies install --jobs ${BUILD_JOBS} --types source --source-packages boost
COPY docker/tofino/re2-patch-object.py /tmp/re2-patch-object.py
RUN python3 /tmp/re2-patch-object.py \
    && python3 ./p4studio dependencies install --jobs ${BUILD_JOBS} --types source --source-packages libcli,libcrafter,grpc
# Upstream configure/build both use this directory; installed artifacts remain
# in the regular /opt/open-p4studio/install image layer.
RUN --mount=type=cache,id=unicorn-tofino-build-${OPEN_P4STUDIO_REV}-${P4C_REV},target=/opt/open-p4studio/build,sharing=locked \
    python3 ./p4studio profile apply --skip-dependencies --jobs ${BUILD_JOBS} /tmp/unicorn-profile.yaml
ENV UNICORN_OPEN_P4STUDIO_REV=${OPEN_P4STUDIO_REV} UNICORN_TOFINO_P4C_REV=${P4C_REV}
ENV SDE=/opt/open-p4studio SDE_INSTALL=/opt/open-p4studio/install

# SDK_IMAGE may be the source stage above or a pinned, matching public SDK image.
# BuildKit prunes the source stage completely when a prebuilt image is selected.
FROM ${SDK_IMAGE} AS sdk
ARG OPEN_P4STUDIO_REV
ARG P4C_REV
COPY docker/tofino/prepare-sdk.py /tmp/prepare-sdk.py
COPY docker/tofino/model-dma.py /tmp/model-dma.py
RUN python3 /tmp/prepare-sdk.py
ENV UNICORN_OPEN_P4STUDIO_REV=${OPEN_P4STUDIO_REV} UNICORN_TOFINO_P4C_REV=${P4C_REV}
ENV SDE=/opt/open-p4studio SDE_INSTALL=/opt/open-p4studio/install
ENV PATH=/opt/open-p4studio/install/bin:$PATH
ENV LD_LIBRARY_PATH=/opt/open-p4studio/install/lib
ENV UNICORN_TOFINO_MODEL_DMA_PRELOAD=/opt/open-p4studio/install/lib/libunicorn_model_dma.so
FROM sdk AS compiler
WORKDIR /app
COPY runtime/tofino /app/runtime/tofino
COPY examples/p4/tofino /opt/unicorn/tofino/sources
RUN python3 -m runtime.tofino.compile /opt/unicorn/tofino/sources/empty.p4 \
    --output /opt/unicorn/tofino/empty --name unicorn_empty
CMD ["python3", "-m", "runtime.tofino.compiler_service", "--host", "0.0.0.0", "--port", "8080"]

FROM ${NETSIM_IMAGE} AS runtime
ARG OPEN_P4STUDIO_REV
ARG P4C_REV
ENV UNICORN_OPEN_P4STUDIO_REV=${OPEN_P4STUDIO_REV} UNICORN_TOFINO_P4C_REV=${P4C_REV}
COPY --from=sdk /opt/open-p4studio/install /opt/open-p4studio/install
# SDK bfshell embeds Ubuntu's Python3.10; keep it separate from Mininet's Python.
COPY --from=sdk /usr/lib/x86_64-linux-gnu/libpython3.10.so.1.0 /opt/open-p4studio/install/lib/
COPY --from=sdk /usr/lib/python3.10 /opt/open-p4studio/python/lib/python3.10
COPY --from=compiler /opt/unicorn/tofino /opt/unicorn/tofino
ENV SDE=/opt/open-p4studio SDE_INSTALL=/opt/open-p4studio/install
ENV UNICORN_TOFINO_MODEL_DMA_PRELOAD=/opt/open-p4studio/install/lib/libunicorn_model_dma.so
LABEL org.opencontainers.image.source="https://github.com/p4lang/open-p4studio"
ENTRYPOINT ["python3", "-u", "/app/main.py"]

# Reuse the existing language server and add official architecture headers only.
FROM ${BACKEND_IMAGE} AS backend
ARG OPEN_P4STUDIO_REV
ARG P4C_REV
ENV UNICORN_OPEN_P4STUDIO_REV=${OPEN_P4STUDIO_REV} UNICORN_TOFINO_P4C_REV=${P4C_REV}
COPY --from=sdk /opt/open-p4studio/install/share/p4c/p4include/tna.p4 /opt/p4-language-server/p4include/
COPY --from=sdk /opt/open-p4studio/install/share/p4c/p4include/tofino1_*.p4 /opt/p4-language-server/p4include/
COPY --from=sdk /opt/open-p4studio/install/share/p4c/p4include/t2na.p4 /opt/p4-language-server/p4include/
COPY --from=sdk /opt/open-p4studio/install/share/p4c/p4include/tofino2_*.p4 /opt/p4-language-server/p4include/
COPY --from=sdk /opt/open-p4studio/install/share/p4c/p4include/tofino /opt/p4-language-server/p4include/tofino
