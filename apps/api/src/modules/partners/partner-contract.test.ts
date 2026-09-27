import { describe, expect, it } from "vitest";
import {
  completeCreateSchema,
  correctExtractedTravelerSchema,
  ledgerSchema,
  listSchema,
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
  it("accepts opaque pagination cursors returned by the API", () => {
    const cursor = Buffer.from(
      "2026-08-31T12:00:00.000Z|00000000-0000-4000-8000-000000000001",
    ).toString("base64url");
    expect(listSchema.safeParse({ cursor }).success).toBe(true);
    expect(ledgerSchema.safeParse({ cursor }).success).toBe(true);
  });

  it("rejects oversized pagination cursors at the contract boundary", () => {
    expect(listSchema.safeParse({ cursor: "a".repeat(257) }).success).toBe(
      false,
    );
    expect(ledgerSchema.safeParse({ cursor: "a".repeat(257) }).success).toBe(
      false,
    );
  });
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

  it("rejects hosted payment settlement from the server-to-server order contract", () => {
    const result = completeCreateSchema.safeParse({
      externalOrderId: "agency-order-1042",
      externalCustomerId: "customer-91",
      planId: "f17d6006-69fe-42ed-9ec8-47777f7569f1",
      settlement: {
        method: "HOSTED_PAYMENT",
        provider: "KHALTI",
        redirectUrl: "https://partner.example/return",
      },
      documentVerificationId: "00000000-0000-4000-8000-000000000003",
      consent: {
        compatibilityAccepted: true,
        termsAccepted: true,
        privacyAccepted: true,
        acceptedAt: "2026-08-08T00:00:00.000Z",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsafe upload declarations", () => {
    expect(
      uploadSessionSchema.safeParse({
        mode: "EXTRACT_FIRST",
        externalOrderId: "agency-order-1042",
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
        mode: "EXTRACT_FIRST",
        externalOrderId: "agency-order-1042",
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

  it("requires passport and ticket while keeping visa optional", () => {
    const document = (type: "PASSPORT" | "TICKET" | "VISA") => ({
      type,
      fileName: `${type.toLowerCase()}.pdf`,
      contentType: "application/pdf" as const,
      sizeBytes: 100,
    });
    const base = {
      mode: "EXTRACT_FIRST" as const,
      externalOrderId: "agency-order-1045",
    };
    expect(
      uploadSessionSchema.safeParse({
        ...base,
        documents: [document("PASSPORT"), document("TICKET")],
      }).success,
    ).toBe(true);
    expect(
      uploadSessionSchema.safeParse({
        ...base,
        documents: [document("PASSPORT"), document("TICKET"), document("VISA")],
      }).success,
    ).toBe(true);
    expect(
      uploadSessionSchema.safeParse({
        ...base,
        documents: [document("PASSPORT"), document("VISA")],
      }).success,
    ).toBe(false);
  });

  it("accepts the modern extraction-first session without traveler data", () => {
    const document = (type: "PASSPORT" | "TICKET") => ({
      type,
      fileName: `${type.toLowerCase()}.pdf`,
      contentType: "application/pdf" as const,
      sizeBytes: 100,
    });
    expect(
      uploadSessionSchema.safeParse({
        mode: "EXTRACT_FIRST",
        externalOrderId: "agency-order-extract-first",
        documents: [document("PASSPORT"), document("TICKET")],
      }).success,
    ).toBe(true);
  });

  it("does not accept traveler data in extraction-first mode", () => {
    expect(
      uploadSessionSchema.safeParse({
        mode: "EXTRACT_FIRST",
        externalOrderId: "agency-order-invalid-mix",
        traveler,
        documents: [
          {
            type: "PASSPORT",
            fileName: "passport.pdf",
            contentType: "application/pdf",
            sizeBytes: 100,
          },
          {
            type: "TICKET",
            fileName: "ticket.pdf",
            contentType: "application/pdf",
            sizeBytes: 100,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("correctExtractedTraveler schema", () => {
  it("accepts a valid correction with a reason", () => {
    expect(
      correctExtractedTravelerSchema.safeParse({
        traveler,
        reason: "Passport number was transposed during extraction",
      }).success,
    ).toBe(true);
  });

  it("rejects an empty reason", () => {
    expect(
      correctExtractedTravelerSchema.safeParse({
        traveler,
        reason: "",
      }).success,
    ).toBe(false);
  });

  it("rejects a reason shorter than 10 characters", () => {
    expect(
      correctExtractedTravelerSchema.safeParse({
        traveler,
        reason: "short",
      }).success,
    ).toBe(false);
  });

  it("rejects a reason longer than 500 characters", () => {
    expect(
      correctExtractedTravelerSchema.safeParse({
        traveler,
        reason: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("rejects a correction without traveler data", () => {
    expect(
      correctExtractedTravelerSchema.safeParse({
        reason: "Passport number was transposed during extraction",
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(
      correctExtractedTravelerSchema.safeParse({
        traveler,
        reason: "Passport number was transposed during extraction",
        version: 5,
      }).success,
    ).toBe(false);
  });
});
