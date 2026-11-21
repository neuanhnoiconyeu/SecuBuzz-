# syntax=docker/dockerfile:1
# Build only for regression validation; this is not a third application service.
ARG FRONTEND_IMAGE
ARG BACKEND_IMAGE
FROM ${FRONTEND_IMAGE} AS frontend
FROM ${BACKEND_IMAGE}
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=frontend --chown=node:node /workspace/client/ /workspace/client/
COPY --chown=node:node docker/validate.cjs ./docker/validate.cjs
RUN test -s /etc/passwd && id node \
    && test -s /workspace/client/package.json \
    && test -s /workspace/docker/validate.cjs \
    && node --check /workspace/docker/validate.cjs
ENV CHROME_PATH=/usr/bin/chromium NEXT_TELEMETRY_DISABLED=1
USER node
CMD ["node", "docker/validate.cjs", "client"]
