# ADR-004: BullMQ and Redis TCP

## Decision

Use BullMQ with a Redis TCP connection for provisioning, callbacks, payments, notifications, and reconciliation. Upstash REST tokens alone are not a supported BullMQ transport.

Jobs use deterministic IDs, bounded exponential retry, dead-letter visibility, and correlation IDs.
