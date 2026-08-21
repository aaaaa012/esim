# One platform-neutral image serves the API, workflow worker, OCR worker, and
# scheduler/reconciler. Override CMD per service; all processes use the same
# build and therefore the same Prisma schema and business code.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @visa-compass/shared build \
 && pnpm --filter @visa-compass/api prisma:generate \
 && pnpm --filter @visa-compass/api build

FROM node:22-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages ./packages
COPY --chown=node:node --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4000}/api/v1/health/live || exit 1
# API: default command. Workflow: pnpm start:workflow-worker
# OCR: pnpm start:ocr-worker. Scheduler currently runs inside workflow-worker
# under a distributed lease, so it never depends on the API process.
CMD ["pnpm", "start"]
