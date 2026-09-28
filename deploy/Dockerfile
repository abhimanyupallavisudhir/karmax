# Digest-pinned; Dependabot (.github/dependabot.yml) proposes each refresh.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV NODE_ENV=production \
    KARMAX_HOME=/var/lib/karmax \
    KARMAX_HOST=0.0.0.0 \
    KARMAX_PORT=4505

RUN apt-get update \
    && apt-get install -y --no-install-recommends age bash ca-certificates curl dumb-init gh git gnupg openssh-client python3 ripgrep util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/bash karmax \
    && mkdir -p /app /var/lib/karmax \
    && chown -R karmax:karmax /var/lib/karmax

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY web ./web
COPY vendor ./vendor
USER karmax

EXPOSE 4505
VOLUME ["/var/lib/karmax"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4505/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "start"]
