# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

WORKDIR /workspace
ENV NODE_ENV=development NEXT_TELEMETRY_DISABLED=1

COPY docker/npm-install.conf /root/.npmrc
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix client ci --include=dev --no-audit --no-fund

COPY --chown=node:node client/ ./client/
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node docker/run.cjs docker/healthcheck.cjs ./docker/
# Next may update its private copy of tsconfig/next-env and generate .next-dev.
RUN chown node:node /workspace/client

USER node
EXPOSE 3001
CMD ["node", "docker/run.cjs", "frontend"]
