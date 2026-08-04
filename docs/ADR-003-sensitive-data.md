# ADR-003: Sensitive data handling

## Decision

PII and eSIM activation data use AES-256-GCM application encryption. Exact passport search uses an HMAC blind index. Documents are private assets accessed through short-lived signed URLs. Credentials live only in environment-specific secret stores.

Logs and audit records must redact tokens, document URLs, passport values, activation codes, and QR payloads.
