# Haven API production image. Build from the repo root:
#   docker build -t haven-api .
#   docker run -p 8787:8787 -v haven-data:/data --env-file .env.production haven-api
#
# SQLite and audio recordings live under /data: mount a persistent volume there.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/g2/package.json apps/g2/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build -w @haven/api

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/haven.db \
    AUDIO_STORAGE_PATH=/data/recordings
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/g2/package.json apps/g2/
# Runtime dependencies of the API only (@haven/contracts is bundled into dist).
RUN npm ci --omit=dev --ignore-scripts -w @haven/api --include-workspace-root=false \
    && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/api/dist/index.js"]
