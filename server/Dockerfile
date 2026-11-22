# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

WORKDIR /workspace
ENV NODE_ENV=development

# Retain compiler fallback for better-sqlite3/argon2 when a prebuild is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./server/
COPY DATA/package.json DATA/package-lock.json ./DATA/
COPY docker/npm-install.conf /root/.npmrc
RUN npm --prefix server ci --include=dev --no-audit --no-fund \
    && npm --prefix DATA ci --include=dev --no-audit --no-fund

COPY --chown=node:node server/ ./server/
COPY --chown=node:node DATA/ ./DATA/
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node docker/run.cjs docker/healthcheck.cjs ./docker/
RUN mkdir -p /var/lib/secubuzz/sqlite /var/lib/secubuzz/attachments \
    && chown node:node /var/lib/secubuzz/sqlite /var/lib/secubuzz/attachments \
    && chmod 0700 /var/lib/secubuzz/sqlite /var/lib/secubuzz/attachments

USER node
EXPOSE 5000
CMD ["node", "docker/run.cjs", "backend"]
