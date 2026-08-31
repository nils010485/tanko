# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile TypeScript packages + build the dashboard
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm install --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/dashboard packages/dashboard
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: lean image with compiled output + vendored legacy connectors
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# headless Chromium for the optional anti-bot browser backend (fetchUI fallback),
# and git for the connectors updater (POST /api/sources/update). Xvfb lets
# puppeteer-real-browser run headful (needed by its Turnstile solver).
RUN apt-get update && apt-get install -y chromium git xvfb \
    && rm -rf /var/lib/apt/lists/*

# compiled packages
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/dashboard/dist packages/dashboard/dist
# vendored legacy Hakuneko connectors (loaded dynamically at runtime)
COPY --from=build /app/packages/core/vendor packages/core/vendor

# all state (SQLite db, settings, downloads) lives under /data
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
