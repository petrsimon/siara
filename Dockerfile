# syntax=docker/dockerfile:1

FROM registry.redhat.io/ubi9/nodejs-20 AS builder

USER root
RUN microdnf install -y python3 make gcc-c++ \
  && microdnf clean all

WORKDIR /opt/app-root/src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM registry.redhat.io/ubi9/nodejs-20

USER root

ARG LITESTREAM_VERSION=v0.5.2
ARG GH_VERSION=v2.63.2

RUN microdnf install -y tar gzip \
  && microdnf clean all \
  && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION#v}-linux-x86_64.tar.gz" \
    | tar xz -C /usr/local/bin litestream \
  && curl -fsSL "https://github.com/cli/cli/releases/download/${GH_VERSION}/gh_${GH_VERSION#v}_linux_amd64.tar.gz" \
    | tar xz -C /usr/local/bin --strip-components=1 "gh_${GH_VERSION#v}_linux_amd64/bin/gh" \
  && chmod +x /usr/local/bin/litestream /usr/local/bin/gh \
  && mkdir -p /data \
  && chgrp -R 0 /data /opt/app-root 2>/dev/null || true \
  && chmod -R g=u /data /opt/app-root 2>/dev/null || true

WORKDIR /opt/app-root/src

COPY --from=builder /opt/app-root/src/dist ./dist
COPY --from=builder /opt/app-root/src/node_modules ./node_modules
COPY package.json ./
COPY litestream.yml ./
COPY scripts/clowder-env.mjs ./scripts/clowder-env.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# The app package is not self-installed into node_modules, so its `bin` (siara)
# has no node_modules/.bin symlink. Provide a wrapper so `siara <cmd>` resolves
# on PATH — both for the entrypoint and inside `litestream replicate -exec`.
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && printf '#!/bin/sh\nexec node /opt/app-root/src/dist/cli.js "$@"\n' > /usr/local/bin/siara \
  && chmod +x /usr/local/bin/siara \
  && chgrp -R 0 /data /opt/app-root 2>/dev/null || true \
  && chmod -R g=u /data /opt/app-root 2>/dev/null || true

ENV SIARA_DB=/data/siara.db

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
USER 1001
