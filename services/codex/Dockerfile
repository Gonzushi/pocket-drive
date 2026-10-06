FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY package.json package-lock.json ./
RUN npm ci && groupadd --gid 1001 drive && useradd --uid 1001 --gid drive --no-create-home drive \
    && mkdir -p /state && chown drive:drive /state
COPY --chown=drive:drive protocol.ts server.ts smoke.ts tsconfig.json ./
RUN npm run build && npm run smoke && npm prune --omit=dev
ENV NODE_ENV=production CODEX_STATE_PATH=/state PORT=4400 SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 1001:1001
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4400/status',{headers:{Authorization:'Bearer '+process.env.ASSISTANT_WORKER_SECRET},signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.ts"]
