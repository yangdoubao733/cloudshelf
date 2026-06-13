FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm config set registry ${NPM_REGISTRY} \
  && npm config set replace-registry-host always \
  && npm ping --registry=${NPM_REGISTRY} \
  && npm ci --omit=dev --no-audit --no-fund \
    --registry=${NPM_REGISTRY} \
    --replace-registry-host=always \
    --fetch-retries=2 \
    --fetch-retry-mintimeout=10000 \
    --fetch-retry-maxtimeout=30000 \
    --fetch-timeout=60000

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/server.js"]
