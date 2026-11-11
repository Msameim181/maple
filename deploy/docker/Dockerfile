# Two images from one dependency install. Build context: repo root.
#   target maple: the Workers (api, ai, alerting, electric-sync, chat-bot, status) on alchemy's
#                 local runtime (workerd), under the `selfhost` profile in alchemy.run.ts
#   target caddy: TLS edge + the dashboard as a static build
FROM oven/bun:1.4.4 AS bun

FROM node:24-bookworm AS deps
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run alchemy:build-deps

FROM deps AS web-build
# Baked into the bundle: the browser's view of the public URLs.
ARG PUBLIC_API_URL
ARG PUBLIC_SYNC_URL
ARG PUBLIC_INGEST_URL
ENV VITE_API_BASE_URL=$PUBLIC_API_URL \
    VITE_API_PUBLIC_URL=$PUBLIC_API_URL \
    VITE_ELECTRIC_SYNC_URL=$PUBLIC_SYNC_URL \
    VITE_INGEST_URL=$PUBLIC_INGEST_URL \
    VITE_MAPLE_SELF_INGEST_URL=$PUBLIC_INGEST_URL \
    VITE_MAPLE_AUTH_MODE=self_hosted \
    VITE_MAPLE_REGION=us \
    VITE_MAPLE_ENVIRONMENT=selfhost
RUN bun run --cwd apps/web build

FROM caddy:2.10 AS caddy
COPY --from=web-build /app/apps/web/dist /srv/web
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile

FROM deps AS maple
ENV NODE_ENV=production \
    ALCHEMY_LOCAL_STATE=1 \
    MAPLE_SELFHOST=1 \
    MAPLE_DEV_APPS=api,ai,alerting,electric-sync,chat-bot,status \
    MAPLE_AUTH_MODE=self_hosted \
    MAPLE_ALERTING_ALLOW_NONPROD=1
# Durable Objects, queues, workflows, KV/R2 and outgoing email live here.
VOLUME /app/.alchemy
EXPOSE 8701 8702 8703 8704 8705 8706
CMD ["deploy/docker/runner/start.sh"]
