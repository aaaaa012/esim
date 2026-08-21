# Visa Compass ops-web (Next.js, internal operations portal).
# Restrict network access to this service (VPN / security group / allowlist) —
# it must never be publicly reachable.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NODE_ENV=production
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @visa-compass/shared build \
 && pnpm --filter @visa-compass/ops-web build

FROM node:22-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app/apps/ops-web
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/ops-web/package.json ./package.json
COPY --from=build /app/apps/ops-web/node_modules ./node_modules
COPY --from=build /app/apps/ops-web/.next ./.next
COPY --from=build /app/apps/ops-web/next.config.ts ./next.config.ts
EXPOSE 3001
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3001}/ || exit 1
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3001"]
