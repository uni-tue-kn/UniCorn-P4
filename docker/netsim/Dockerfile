FROM python:3.12-bookworm
ARG PI_REV=701b9992ca925c90420a0cb31a4fa812f4a4f2f4
ARG BMV2_VERSION=1.15.7
ARG MININET_REV=6eb8973c0bfd13c25c244a3871130c5e36b5fbd7
ARG BUILD_JOBS=2
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates build-essential cmake autoconf automake libtool pkg-config \
    libboost-dev libboost-system-dev libboost-thread-dev libboost-program-options-dev \
    libboost-filesystem-dev libboost-test-dev libboost-iostreams-dev \
    libprotobuf-dev protobuf-compiler protobuf-compiler-grpc libgrpc++-dev \
    libthrift-dev thrift-compiler libnanomsg-dev libpcap-dev libgmp-dev \
    libjsoncpp-dev libxxhash-dev libreadline-dev libgmock-dev \
    iproute2 iputils-ping ethtool net-tools netcat-openbsd socat \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/p4lang/PI.git /src/PI \
    && cd /src/PI && git checkout "${PI_REV}" && git submodule update --init --recursive \
    && ./autogen.sh && ./configure --with-proto --without-internal-rpc \
    && make -j"${BUILD_JOBS}" && make install && ldconfig
COPY runtime/patches/bmv2-thrift-register-uint64.patch /tmp/bmv2-thrift-register-uint64.patch
COPY runtime/patches/bmv2-release-resource-bounds.patch /tmp/bmv2-release-resource-bounds.patch
COPY runtime/patches/bmv2-pcap-nonblocking.patch /tmp/bmv2-pcap-nonblocking.patch
RUN git clone --branch "${BMV2_VERSION}" --depth 1 --recurse-submodules \
      https://github.com/p4lang/behavioral-model.git /src/bmv2 \
    && cd /src/bmv2 && git apply --unidiff-zero /tmp/bmv2-thrift-register-uint64.patch \
    && git apply /tmp/bmv2-release-resource-bounds.patch \
    && git apply /tmp/bmv2-pcap-nonblocking.patch \
    && cmake -S /src/bmv2 -B /src/bmv2/build -DCMAKE_BUILD_TYPE=Release \
      -DWITH_PI=ON \
    && cmake --build /src/bmv2/build --target simple_switch_grpc simple_switch -j"${BUILD_JOBS}" \
    && install -m755 /src/bmv2/build/targets/simple_switch_grpc/simple_switch_grpc \
      /src/bmv2/build/targets/simple_switch/simple_switch \
      /src/bmv2/build/targets/simple_switch/simple_switch_CLI /usr/local/bin/ \
    && cp -a /src/bmv2/build/thrift_src/gen-py/. /usr/local/lib/python3.12/site-packages/ \
    && cp -a /src/bmv2/build/targets/simple_switch/gen-py/. /usr/local/lib/python3.12/site-packages/ \
    && install -m644 /src/bmv2/tools/runtime_CLI.py /src/bmv2/tools/bmpy_utils.py \
      /src/bmv2/targets/simple_switch/sswitch_CLI.py /usr/local/lib/python3.12/site-packages/ \
    && ldconfig \
    && simple_switch_grpc --version
# One official Mininet source installation; no stale PyPI or apt shadow copy.
RUN git clone https://github.com/mininet/mininet.git /src/mininet \
    && cd /src/mininet && git checkout "${MININET_REV}" \
    && pip install --no-cache-dir packaging==26.3 \
    && make mnexec && install -m755 mnexec /usr/local/bin/mnexec \
    && pip install --no-cache-dir --no-deps . \
    && python -c 'from mininet.net import VERSION; print(VERSION)' \
    && command -v mnexec
ENV UNICORN_PI_REV=${PI_REV} \
    UNICORN_MININET_REV=${MININET_REV} \
    UNICORN_BMV2_VERSION=${BMV2_VERSION}
WORKDIR /app
COPY backend/requirements.txt /tmp/backend-requirements.txt
COPY netsim/requirements.txt /tmp/netsim-requirements.txt
RUN pip install --no-cache-dir -r /tmp/backend-requirements.txt -r /tmp/netsim-requirements.txt
COPY netsim/ /app/
COPY backend/controller/ /app/controller/
COPY runtime/ /app/runtime/
COPY unicorn_version.py VERSION /app/
ENV PYTHONPATH=/app
ENTRYPOINT ["python3", "-u", "/app/main.py"]
