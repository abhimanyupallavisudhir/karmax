FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && npm ci --omit=dev --legacy-peer-deps \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    KARMAX_HOME=/var/lib/karmax \
    KARMAX_HOST=0.0.0.0 \
    KARMAX_PORT=4505

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl dumb-init gh git openssh-client ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/bash karmax \
    && mkdir -p /app /var/lib/karmax \
    && chown -R karmax:karmax /app /var/lib/karmax

WORKDIR /app
COPY --from=dependencies --chown=karmax:karmax /app/node_modules ./node_modules
COPY --chown=karmax:karmax package.json package-lock.json tsconfig.json ./
COPY --chown=karmax:karmax src ./src
COPY --chown=karmax:karmax web ./web
USER karmax

EXPOSE 4505
VOLUME ["/var/lib/karmax"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4505/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "start"]
