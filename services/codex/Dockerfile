FROM node:24-bookworm-slim
WORKDIR /worker
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && groupadd --gid 1001 drive && useradd --uid 1001 --gid drive --no-create-home drive \
    && mkdir -p /state && chown drive:drive /state
COPY --chown=drive:drive protocol.mjs server.mjs ./
ENV NODE_ENV=production CODEX_STATE_PATH=/state PORT=4400
USER 1001:1001
EXPOSE 4400
CMD ["node", "server.mjs"]
