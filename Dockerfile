# Muesli server image (ADR 0017): one container = sync server + the built web app.
# Run behind Traefik (docker-compose.prod.yml); config entirely via env.

# --- web app ---------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @muesli/web
COPY apps/web apps/web
RUN pnpm --filter @muesli/web exec vite build

# --- server ----------------------------------------------------------------
FROM rust:1.86-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release -p muesli-server

# --- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/muesli-server /usr/local/bin/muesli-server
COPY --from=web /src/apps/web/dist /srv/muesli-web

ENV MUESLI_WEB_DIR=/srv/muesli-web \
    MUESLI_LISTEN=0.0.0.0:8787
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
    CMD curl -fsS http://localhost:8787/healthz || exit 1
CMD ["muesli-server"]
