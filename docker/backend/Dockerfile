FROM python:3.12-bullseye

# Install necessary dependencies for adding repositories and keys
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Add the p4lang repository
RUN echo 'deb http://download.opensuse.org/repositories/home:/p4lang/Debian_11/ /' > /etc/apt/sources.list.d/home:p4lang.list

# Import the GPG key for the p4lang repository
RUN curl -fsSL https://download.opensuse.org/repositories/home:p4lang/Debian_11/Release.key | gpg --dearmor -o /etc/apt/trusted.gpg.d/home_p4lang.gpg

# Update the package lists
RUN apt-get update

# Install the p4lang-bmv2 package
RUN apt-get install -y p4lang-bmv2 mininet p4lang-p4c

# Clean up APT when done
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /requirements.txt
RUN pip3 install -r requirements.txt

RUN mkdir /app
RUN mkdir /p4
WORKDIR /app

ENTRYPOINT ["python3", "-u",  "/app/main.py"]