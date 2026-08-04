# ADR-002: Provider adapters

## Decision

Payment and connectivity providers implement internal contracts. Raw provider DTOs never enter order, inventory, or customer services.

Transatel is the connectivity provider. Its OCS preload, inventory, catalog, eSIM-management and webhook APIs are adapted through the internal `ConnectivityProvider` contract. Khalti and eSewa follow the same payment contract.
