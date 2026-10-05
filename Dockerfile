FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 STORAGE_PATH=/app/storage
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libreoffice-writer libreoffice-impress fonts-dejavu-core fonts-liberation util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1001 drive && useradd --uid 1001 --gid drive --no-create-home drive \
    && mkdir -p /app/storage && chown drive:drive /app/storage
COPY --from=builder --chown=drive:drive /app/.next/standalone ./
COPY --from=builder --chown=drive:drive /app/.next/static ./.next/static
USER 1001:1001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
