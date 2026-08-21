# CockroachDB to PostgreSQL migration runbook

This is a maintenance-window migration. PostgreSQL becomes authoritative only
after the final validation passes. Never commit or print any connection URL.

## Security and roles

1. Rotate every database password that has appeared in chat, logs, or shell
   history.
2. Create a migration role that can create and alter the `visa_compass` schema.
3. Create a separate application role with `USAGE` on the schema and only the
   table/sequence privileges required by Prisma.
4. Keep the existing application encryption and PII hashing keys unchanged.

Every PostgreSQL URL must include `schema=visa_compass` and `sslmode=require`.
`DATABASE_URL` may use a Supabase session pooler. `DIRECT_DATABASE_URL` must be
a direct database connection for Prisma Migrate, backup, and restore. On AWS
RDS, both variables may use the RDS endpoint with different roles.

## Rehearsal

1. Stop if the target already contains application data.
2. Generate clients and apply the PostgreSQL baseline:
   `pnpm db:generate && pnpm db:deploy`.
3. Set `SOURCE_DATABASE_URL` to CockroachDB, `DATABASE_URL` to the target, and
   `DIRECT_DATABASE_URL` to the direct target URL.
4. Run `pnpm db:transfer`, then `pnpm db:validate-transfer`.
5. Run the API tests and all customer, partner, payment, inventory,
   provisioning, document, notification, refund, and Ops smoke tests.
6. Destroy the rehearsal schema after recording timings and results.

The transfer checkpoint contains model names and counts only. Delete it before
starting a new empty target. A failed or mismatched transfer is recovered by
dropping and recreating only the disposable `visa_compass` target schema.

## Production cutover

1. Enable maintenance mode and stop API writes, workers, schedulers, callback
   processing, and reconciliation.
2. Take and verify a final CockroachDB backup. Record source model counts.
3. Apply the PostgreSQL baseline to an empty `visa_compass` schema.
4. Run the data transfer and validation commands from the rehearsal.
5. Confirm zero fingerprint mismatches and run financial, inventory ownership,
   provider-reference, and foreign-key checks.
6. Change all services to the same PostgreSQL environment. Run `pnpm db:deploy`
   once as the release migration step; ordinary API startup does not migrate.
7. Start workflow/OCR workers and schedulers, then the API and portals.
8. Complete smoke tests before reopening traffic.

If any check fails before traffic reopens, stop and restore the CockroachDB
configuration. Once PostgreSQL accepts production writes, CockroachDB is a
read-only verification archive—not an automatic rollback target. Retain it for
30 days, then remove it according to the data-retention policy.

## Backup and restore

Enable Supabase or RDS point-in-time recovery and run `scripts/db-backup.sh`
nightly using `DIRECT_DATABASE_URL`. Store encrypted backups in a separate
provider account. At least monthly, restore a dump into a scratch PostgreSQL
database, apply pending migrations, and run integrity and application smoke
tests.
