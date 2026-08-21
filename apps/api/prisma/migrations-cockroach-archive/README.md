# Archived CockroachDB migration history

These migrations are immutable evidence of the schema history applied to the
former CockroachDB database. They are not read by `prisma migrate deploy` and
must not be modified, replayed against PostgreSQL, or moved back into the active
`migrations` directory.

PostgreSQL environments start from
`migrations/00000000000000_postgresql_baseline` and use only subsequent
PostgreSQL migrations.
