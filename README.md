# Visa Compass eSIM

TypeScript monorepo for the Visa Compass customer portal, operations portal, and modular NestJS API.

## Start locally

1. Copy `.env.example` to `.env` and provide local services/keys.
2. Run `pnpm install`.
3. Run `pnpm db:generate` and `pnpm db:migrate`.
4. Run `pnpm db:seed`.
5. Run `pnpm dev`.

Customer web runs on `3000`, operations web on `3001`, and the API on `4000`. Swagger is available at `/api/docs`.

Payment and Auriga simulators are enabled only outside production. Live payment confirmation always requires provider-side verification.
