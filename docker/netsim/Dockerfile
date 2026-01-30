FROM python:3.12-bullseye

# Install necessary dependencies for adding repositories and keys
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Add the p4lang repository (trusted=yes to work around expired upstream GPG key)
RUN echo 'deb [trusted=yes] https://ftp.gwdg.de/pub/opensuse/repositories/home:/p4lang/Debian_11/ /' > /etc/apt/sources.list.d/home:p4lang.list

# Update the package lists
RUN apt-get update

# Install the p4lang-bmv2, mininet and utils
RUN apt-get install -y p4lang-bmv2 mininet ethtool iputils-ping netcat

# Clean up APT when done
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir /app
RUN mkdir /p4
RUN mn -c
WORKDIR /app/netsim

# Copy the app files to the container
COPY netsim /app
# Ensure that necessary python libraries are installed
RUN pip3 install -r /app/requirements.txt

ENTRYPOINT ["python3", "/app/main.py"]