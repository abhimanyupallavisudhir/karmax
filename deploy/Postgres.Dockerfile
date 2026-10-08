# PostgreSQL with WAL-G for continuous off-host backups (deploy/postgres/pg-backup.sh;
# wiki ops/production-tavya). Same major version and data format as the stock
# image it extends; with no backup settings it behaves exactly like it.
ARG POSTGRES_VERSION=16
FROM postgres:${POSTGRES_VERSION}

# WAL-G v3.0.9 (2026-08-20), the Ubuntu 22.04 build: glibc 2.35, which the
# Debian bookworm base satisfies. The checksums are the release's own .sha256
# files; a new version needs both updated.
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) asset=wal-g-pg-22.04-amd64; sum=d6795c663894d836ba20840bffe8970aed81bbe25d3151bd4951f6f9c362def9 ;; \
      arm64) asset=wal-g-pg-22.04-aarch64; sum=072eb4a4a119f817e1fa888c64a776b01e3453b2e0d967a67d149adb18fde652 ;; \
      *) echo "no WAL-G build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl jq; \
    curl -fsSL --retry 3 -o /usr/local/bin/wal-g "https://github.com/wal-g/wal-g/releases/download/v3.0.9/$asset"; \
    echo "$sum  /usr/local/bin/wal-g" | sha256sum -c -; \
    chmod 755 /usr/local/bin/wal-g; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    wal-g --version

COPY --chmod=755 postgres/pg-backup.sh /usr/local/bin/karmax-pg-backup
