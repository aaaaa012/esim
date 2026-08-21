# Visa Compass API — single-instance NestJS service + in-process BullMQ workers.
# Build:  docker build -f apps/api/Dockerfile -t visa-compass-api .
# Run:    docker run --env-file .env -p 4000:4000 visa-compass-api
# NOTE: ORDER_WORKFLOW_MODE must stay single-instance (see docs/PRODUCTION-DEPLOYMENT-ARCHITECTURE.md).

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @visa-compass/shared build \
 && pnpm --filter @visa-compass/api build

FROM node:22-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4000}/api/v1/health/live || exit 1
CMD ["node", "dist/src/main.js"]
