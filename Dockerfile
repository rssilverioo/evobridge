# EvoBridge: one image, one process (API + dashboard + webhook worker), SQLite in /data.
# Base images come from the AWS mirror of Docker Hub's official images, so builds don't
# depend on Docker Hub rate limits or outages.

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 CI=true
# Toolchain for native modules (better-sqlite3, argon2) when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Production dependencies of the server only (the dashboard is static files by now).
RUN pnpm --filter @evobridge/server deploy --prod /out

FROM public.ecr.aws/docker/library/node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    WEB_DIR=/app/web
WORKDIR /app
RUN groupadd --system evobridge && useradd --system --gid evobridge --home /app evobridge \
    && mkdir -p /data && chown evobridge:evobridge /data
COPY --from=build --chown=evobridge:evobridge /out/node_modules /app/node_modules
COPY --from=build --chown=evobridge:evobridge /out/package.json /app/package.json
COPY --from=build --chown=evobridge:evobridge /src/apps/server/dist /app/dist
COPY --from=build --chown=evobridge:evobridge /src/apps/web/out /app/web
USER evobridge
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
