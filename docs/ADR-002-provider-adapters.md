# ADR-002: Provider adapters

## Decision

Payment and connectivity providers implement internal contracts. Raw provider DTOs never enter order, inventory, or customer services.

Auriga is the first connectivity target. Until its contract is supplied, a deterministic mock supports the complete workflow. Khalti and eSewa follow the same payment contract.
