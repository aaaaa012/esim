# Visa Compass customer-web (Next.js). Build with:
#   docker build -f apps/customer-web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 \
#     -t visa-compass-web .
# NEXT_PUBLIC_* vars are inlined at BUILD time — rebuild the image when they change.

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
 && pnpm --filter @visa-compass/customer-web build

FROM node:22-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app/apps/customer-web
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/customer-web/package.json ./package.json
COPY --from=build /app/apps/customer-web/node_modules ./node_modules
COPY --from=build /app/apps/customer-web/.next ./.next
COPY --from=build /app/apps/customer-web/public ./public
COPY --from=build /app/apps/customer-web/next.config.ts ./next.config.ts
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/ || exit 1
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
