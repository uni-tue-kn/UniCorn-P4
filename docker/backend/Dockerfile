FROM python:3.12-bookworm AS compiler
ARG P4C_VERSION=v1.2.5.18
ARG BUILD_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates build-essential cmake ninja-build bison flex \
    libboost-dev libboost-iostreams-dev libboost-graph-dev libgc-dev \
    libgmp-dev libfl-dev pkg-config libprotobuf-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
COPY runtime/patches/p4c-gcc12-erase-if.patch /tmp/p4c-gcc12-erase-if.patch
RUN git clone --branch "${P4C_VERSION}" --depth 1 --recurse-submodules \
      https://github.com/p4lang/p4c.git /src/p4c \
    && cd /src/p4c && git apply /tmp/p4c-gcc12-erase-if.patch \
    && cmake -S /src/p4c -B /src/p4c/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS_RELEASE='-O1 -DNDEBUG' \
      -DCMAKE_INSTALL_PREFIX=/opt/p4c \
      -DENABLE_BMV2=ON -DENABLE_EBPF=OFF -DENABLE_UBPF=OFF \
      -DENABLE_DPDK=OFF -DENABLE_P4TC=OFF -DENABLE_P4TEST=OFF \
      -DENABLE_P4FMT=OFF -DENABLE_P4C_GRAPHS=OFF -DENABLE_GTESTS=OFF \
    && cmake --build /src/p4c/build -j"${BUILD_JOBS}" \
    && cmake --install /src/p4c/build
FROM node:24-bookworm-slim AS p4-language-server
ARG P4_LANGUAGE_SERVER_REV=48428a3bd9cb5508454eb2db2c73838be4076ffd
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/fattaholmanan/p4-vscode-extension.git /src/p4-language-server \
    && cd /src/p4-language-server && git checkout "${P4_LANGUAGE_SERVER_REV}"
COPY runtime/p4-language-server/adapt-server.mjs /tmp/adapt-server.mjs
RUN node /tmp/adapt-server.mjs /src/p4-language-server \
    && cd /src/p4-language-server && npm ci --ignore-scripts \
    && node esbuild.js --production \
    && mkdir -p /opt/p4-language-server/server/out \
    && cp server/out/server.js /opt/p4-language-server/server/out/ \
    && cp LICENSE README.md /opt/p4-language-server/

FROM python:3.12-bookworm
ARG P4C_VERSION=v1.2.5.18
RUN apt-get update && apt-get install -y --no-install-recommends \
    libboost-iostreams1.74.0 libboost-graph1.74.0 libgc1 libgmp10 libprotobuf32 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=compiler /opt/p4c /opt/p4c
COPY --from=p4-language-server /usr/local/bin/node /usr/local/bin/node
COPY --from=p4-language-server /opt/p4-language-server /opt/p4-language-server
COPY --from=compiler /opt/p4c/share/p4c/p4include /opt/p4-language-server/p4include
ENV PATH=/opt/p4c/bin:$PATH
ENV UNICORN_P4C_VERSION=${P4C_VERSION}
ENV P4_LANGUAGE_SERVER=/opt/p4-language-server/server/out/server.js
WORKDIR /app
COPY backend/requirements.txt /tmp/backend-requirements.txt
RUN pip install --no-cache-dir -r /tmp/backend-requirements.txt
COPY backend/ /app/
COPY runtime/ /app/runtime/
COPY unicorn_version.py VERSION /app/
ENTRYPOINT ["python3", "-u", "/app/main.py"]
