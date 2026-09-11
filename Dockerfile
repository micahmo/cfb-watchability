# syntax=docker/dockerfile:1

# --- build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# tzdata is needed for TZ to resolve: the poller asks ESPN for "yesterday through
# today", and those day boundaries have to be in US Eastern or late kickoffs fall
# outside the window.
RUN apk add --no-cache tzdata wget su-exec

# Production dependencies only. The server ran on the Node standard library alone
# until web push arrived, which needs VAPID signing and payload encryption and is
# not something to hand-roll. Omitting this stage is what took the container down
# on the first deploy after adding it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DIST_DIR=/app/dist \
    TZ=America/New_York \
    PUID=1000 \
    PGID=1000

EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist-server/server/index.js"]
