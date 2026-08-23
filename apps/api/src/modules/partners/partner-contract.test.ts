import { describe, expect, it } from "vitest";
import {
  completeCreateSchema,
  uploadSessionSchema,
} from "./partners.controller.js";

const traveler = {
  title: "MR",
  firstName: "Samir",
  surname: "Majhi",
  dateOfBirth: "1995-01-01",
  nationality: "NP",
  city: "Kathmandu",
  countryOfResidence: "NP",
  email: "customer@example.com",
  mobile: "+9779800000000",
  passportNumber: "PA1234567",
  passportExpiryDate: "2030-01-01",
} as const;

describe("simplified partner order contract", () => {
  it("accepts one complete ledger order", () => {
    expect(
      completeCreateSchema.safeParse({
        externalOrderId: "agency-order-1042",
        externalCustomerId: "customer-91",
        planId: "f17d6006-69fe-42ed-9ec8-47777f7569f1",
        settlement: { method: "PARTNER_ACCOUNT" },
        documentVerificationId: "00000000-0000-4000-8000-000000000003",
        consent: {
          compatibilityAccepted: true,
          termsAccepted: true,
          privacyAccepted: true,
          acceptedAt: "2026-08-08T00:00:00.000Z",
        },
      }).success,
    ).toBe(true);
  });

  it("defaults complete orders to the prepaid partner account", () => {
    const result = completeCreateSchema.safeParse({
      externalOrderId: "agency-order-1043",
      externalCustomerId: "customer-91",
      planId: "f17d6006-69fe-42ed-9ec8-47777f7569f1",
      documentVerificationId: "00000000-0000-4000-8000-000000000003",
      consent: {
        compatibilityAccepted: true,
        termsAccepted: true,
        privacyAccepted: true,
        acceptedAt: "2026-08-08T00:00:00.000Z",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.settlement).toBeUndefined();
  });

  it("accepts a direct top-up without document verification", () => {
    expect(
      completeCreateSchema.safeParse({
        externalOrderId: "agency-topup-1044",
        externalCustomerId: "customer-91",
        planId: "f17d6006-69fe-42ed-9ec8-47777f7569f1",
        topUpMobile: "+9779800000000",
        consent: {
          compatibilityAccepted: true,
          termsAccepted: true,
          privacyAccepted: true,
          acceptedAt: "2026-08-08T00:00:00.000Z",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects the former direct traveler and document order contract", () => {
    expect(
      completeCreateSchema.safeParse({
        externalOrderId: "agency-order-old",
        externalCustomerId: "customer-91",
        planId: "f17d6006-69fe-42ed-9ec8-47777f7569f1",
        traveler,
        documents: [
          {
            type: "PASSPORT",
            uploadId: "00000000-0000-4000-8000-000000000001",
          },
          { type: "TICKET", uploadId: "00000000-0000-4000-8000-000000000002" },
        ],
        consent: {
          compatibilityAccepted: true,
          termsAccepted: true,
          privacyAccepted: true,
          acceptedAt: "2026-08-08T00:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  it("requires hosted payment provider and redirect URL", () => {
    const result = completeCreateSchema.safeParse({
      externalOrderId: "agency-order-1042",
      externalCustomerId: "customer-91",
      planId: "f17d6006-69fe-42ed-9ec8-47777f7569f1",
      settlement: { method: "HOSTED_PAYMENT" },
      traveler,
      documents: [],
      consent: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsafe upload declarations", () => {
    expect(
      uploadSessionSchema.safeParse({
        externalOrderId: "agency-order-1042",
        traveler,
        documents: [
          {
            type: "PASSPORT",
            fileName: "passport.exe",
            contentType: "application/octet-stream",
            sizeBytes: 11 * 1024 * 1024,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate document types", () => {
    expect(
      uploadSessionSchema.safeParse({
        externalOrderId: "agency-order-1042",
        traveler,
        documents: [
          {
            type: "PASSPORT",
            fileName: "one.pdf",
            contentType: "application/pdf",
            sizeBytes: 100,
          },
          {
            type: "PASSPORT",
            fileName: "two.pdf",
            contentType: "application/pdf",
            sizeBytes: 100,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
