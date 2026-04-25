# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /workspace

COPY service/base/package.json service/base/package-lock.json ./service/base/
WORKDIR /workspace/service/base
RUN npm ci

COPY service/base ./
RUN npm run build   && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    EASY_EMAIL_CONFIG_PATH=/etc/easy-email/config.yaml \
    EASY_EMAIL_STATE_DIR=/var/lib/easy-email

COPY --from=builder /workspace/service/base/package.json ./package.json
COPY --from=builder /workspace/service/base/package-lock.json ./package-lock.json
COPY --from=builder /workspace/service/base/node_modules ./node_modules
COPY --from=builder /workspace/service/base/dist ./dist

COPY deploy/service/base/config.template.yaml /opt/easy-email/config.template.yaml
COPY deploy/service/base/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --fix-missing --no-install-recommends ca-certificates gosu python3 python3-pip \
    && python3 -m pip install --no-cache-dir --break-system-packages cloudscraper \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 easy \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /etc/easy-email /var/lib/easy-email/state \
    && chown -R easy:easy /etc/easy-email /var/lib/easy-email /opt/easy-email

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
