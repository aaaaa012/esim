# ADR-001: Modular monolith

## Decision

Use a NestJS modular monolith with explicit domain modules, two independently deployable Next.js portals, and one PostgreSQL database.

## Consequences

Cross-domain work uses application services and transactions rather than network calls. Provider integrations remain replaceable adapters. Modules may be extracted only when operational evidence justifies it.
