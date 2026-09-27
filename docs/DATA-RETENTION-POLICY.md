# Data Retention Policy

## Activation and ownership

Automated retention is disabled by default. The production owner must obtain
written approval from Legal, Security, Finance, and Operations before setting
`DATA_RETENTION_ENABLED=true`. The approved values must be recorded in the
deployment change request and reviewed at least annually.

## Default schedule

| Data class                |              Default | Eligibility                                                       | Exception                                                                                 |
| ------------------------- | -------------------: | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Integration request logs  |             365 days | Records older than the cutoff                                     | Extend retention during an incident, dispute, or legal hold                               |
| Incoming webhook evidence |             365 days | Successfully processed records with no error or dead-letter state | Unprocessed, failed, and dead-letter records are never automatically deleted              |
| Customer notifications    |             365 days | Successfully sent records with no error                           | Queued and failed notifications are never automatically deleted                           |
| Administrative audit logs | 2,555 days (7 years) | Records older than the cutoff                                     | Extend retention for regulatory, financial, security, dispute, or legal-hold requirements |

Deletion runs in bounded batches (`DATA_RETENTION_BATCH_SIZE`, default 250) as
part of reconciliation. Every non-empty sweep creates a `DATA_RETENTION_SWEEP`
audit record containing counts and the effective policy. Operators must monitor
reconciliation health and retain database backups according to the approved
backup lifecycle.

## Erasure and legal holds

Automated retention is not a data-subject erasure workflow. Erasure requests
must be identity-verified, approved, and checked for contractual, fraud,
financial, security, and legal-hold exceptions. Where evidence must be retained,
access should be restricted and directly identifying fields minimized instead
of deleting the evidentiary record.

Before changing a retention value, confirm that backup expiry, replicas,
analytics exports, object storage, and downstream processors follow the same
approved schedule. A production restore test must verify that expired records
do not reappear from backups after their approved backup-retention window.
