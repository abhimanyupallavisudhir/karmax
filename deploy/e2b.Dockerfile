FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git jq openssh-client python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash user

USER user
WORKDIR /home/user

# Provider setup clones the project into /home/user/karmax. Keeping dependencies
# in the immutable template makes cold starts predictable; project-specific
# dependencies remain the project's responsibility (`npm ci`, etc.).
RUN git --version && node --version && npm --version && rg --version
