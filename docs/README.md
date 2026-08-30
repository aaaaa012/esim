# Visa Compass Documentation

Implementation-traceable documentation for the Visa Compass eSIM platform.
Every behavior described in these documents was reverse-engineered from the
source in this repository. Where a behavior, rule, or response cannot be
determined from the code, it is explicitly marked `UNKNOWN / NOT DETERMINABLE
FROM CODE` rather than guessed.

## Reading order

| Document                                                                                     | Topic                                                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [01-system-overview.md](./01-system-overview.md)                                             | What the system is, the application boundaries, module wiring, and runtime behavior |
| [02-repository-layout.md](./02-repository-layout.md)                                         | Monorepo layout, workspaces, tooling, scripts, and quality gates                    |
| [03-configuration-environment.md](./03-configuration-environment.md)                         | Every environment variable read by the code and what it changes                     |
| [04-api-surface.md](./04-api-surface.md)                                                     | Full HTTP endpoint inventory, response envelope, error contract                     |
| [05-authentication-authorization.md](./05-authentication-authorization.md)                   | Clerk integration, guards, RBAC, MFA, partner API keys                              |
| [06-domain-model-orders.md](./06-domain-model-orders.md)                                     | The order state machine and the in-memory `DemoOrder` shape                         |
| [07-order-lifecycle-flows.md](./07-order-lifecycle-flows.md)                                 | Purchase, document, payment, provisioning, refund, guest and partner flows          |
| [08-payments.md](./08-payments.md)                                                           | Payment gateway adapters: simulator, Khalti                                         |
| [09-connectivity-transatel.md](./09-connectivity-transatel.md)                               | Transatel connectivity adapter: provisioning, usage, catalog, eligibility, webhooks |
| [ADR-005-transatel-resilient-provisioning.md](./ADR-005-transatel-resilient-provisioning.md) | Durable Transatel provisioning saga, idempotency, reconciliation, and webhook inbox |
| [10-inventory.md](./10-inventory.md)                                                         | eSIM inventory lifecycle, batches, reservation, import                              |
| [11-notifications.md](./11-notifications.md)                                                 | Notification templates, channels, QR delivery                                       |
| [12-background-jobs.md](./12-background-jobs.md)                                             | BullMQ queues, workers, processors, reconciliation                                  |
| [13-data-persistence.md](./13-data-persistence.md)                                           | Prisma schema, persistence modes, orders persistence, crypto                        |
| [14-document-storage.md](./14-document-storage.md)                                           | Private document storage: Amazon S3 signed uploads and the local simulator         |
| [15-webhooks-integration-events.md](./15-webhooks-integration-events.md)                     | Inbound webhooks, signature verification, events and integration logs               |
| [16-shared-contracts.md](./16-shared-contracts.md)                                           | The `@visa-compass/shared` package: contracts, schemas, error codes                 |
| [17-customer-web.md](./17-customer-web.md)                                                   | Customer portal pages and their API calls                                           |
| [18-ops-web.md](./18-ops-web.md)                                                             | Operations portal pages and their API calls                                         |
| [19-observability-hardening.md](./19-observability-hardening.md)                             | Health, rate limiting, logging, correlation, exception handling, audit              |
| [20-documentation-gaps.md](./20-documentation-gaps.md)                                       | Things that could not be determined from the code                                   |
| [PRODUCTION-SCENARIO-ACCEPTANCE.md](./PRODUCTION-SCENARIO-ACCEPTANCE.md)                     | Production failure scenarios, implemented controls, and launch evidence             |
| [AWS-S3-SES-MIGRATION.md](./AWS-S3-SES-MIGRATION.md)                                       | AWS bucket, IAM, SES, object-copy, smoke, and rollback cutover runbook               |

## Pre-existing documentation

The following documents predate this set and remain authoritative for the
topics they cover. They are referenced from the numbered documents where
relevant.

- [ADR-001-modular-monolith.md](./ADR-001-modular-monolith.md)
- [ADR-002-provider-adapters.md](./ADR-002-provider-adapters.md)
- [ADR-003-sensitive-data.md](./ADR-003-sensitive-data.md)
- [ADR-004-jobs.md](./ADR-004-jobs.md)
- [BUSINESS-OVERVIEW.md](./BUSINESS-OVERVIEW.md)
- [CUSTOMER-JOURNEY-END-TO-END.md](./CUSTOMER-JOURNEY-END-TO-END.md)
- [CUSTOMER-JOURNEY-MAPPING-LAYMAN.md](./CUSTOMER-JOURNEY-MAPPING-LAYMAN.md)
- [PARTNER-API-v1.md](./PARTNER-API-v1.md)
- [PartnersApi2.0.md](./PartnersApi2.0.md)
- [PLATFORM-SPECIFICATION.md](./PLATFORM-SPECIFICATION.md)

## Citation convention

File references use the repository-relative path and, where available, the
function or class name, e.g. `apps/api/src/modules/orders/orders.service.ts`
→ `OrdersService.create`. Line numbers are given for precise claims.
