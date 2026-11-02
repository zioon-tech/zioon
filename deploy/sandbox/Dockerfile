FROM node:22-bookworm

# Candidate image for Alibaba's second-generation runtime.
# Provider injects envd. Do not start the production Runtime or copy its secrets.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       systemd systemd-sysv openssh-server sudo chrony fuse3 iptables \
       python3 python3-venv git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /data/user-tools /data/plugin-data \
    && chmod 0770 /workspace /data/user-tools /data/plugin-data

WORKDIR /workspace
USER root
