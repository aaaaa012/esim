import { describe, expect, it } from "vitest";
import { createOrderSchema } from "./schemas.js";

const planId = "123e4567-e89b-42d3-a456-426614174000";

describe("customer checkout consent", () => {
  it("requires explicit compatibility, terms and privacy acceptance", () => {
    expect(createOrderSchema.safeParse({ planId, compatibilityAccepted: true }).success).toBe(false);
    expect(createOrderSchema.safeParse({ planId, compatibilityAccepted: true, termsAccepted: true, privacyAccepted: true }).success).toBe(true);
  });
});
