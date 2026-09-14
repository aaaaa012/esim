import { describe, expect, it, vi } from "vitest";
import { PassportOcrProcessor } from "./passport-ocr.processor.js";

function processor(
  prisma: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  return new PassportOcrProcessor(
    { registerWorker: vi.fn() } as never,
    prisma as never,
    {
      decrypt: vi.fn((value: string) => value),
      encrypt: vi.fn((value: string) => `encrypted:${value}`),
    } as never,
    {
      verify: vi.fn().mockResolvedValue(result),
      extract: vi.fn().mockResolvedValue(result),
    } as never,
    {
      verifyDocument: vi.fn().mockResolvedValue({ bytes: 500, format: "png" }),
    } as never,
    { attention: vi.fn(), resolve: vi.fn() } as never,
  );
}

const verification = {
  id: "verification-1",
  partnerId: "partner-1",
  externalOrderId: "external-1",
  status: "PROCESSING",
  expiresAt: new Date(Date.now() + 60_000),
  consumedOrderId: null,
  travelerSnapshot: {
    firstName: "Test",
    surname: "Traveler",
    dateOfBirthEncrypted: "1990-01-01",
    passportNumberEncrypted: "PA1234567",
    passportExpiryEncrypted: "2030-01-01",
  },
  documents: [
    {
      id: "passport-1",
      type: "PASSPORT",
      fileName: "passport.png",
      privateAssetId: "asset-passport",
      contentType: "image/png",
      declaredSizeBytes: 500,
    },
    {
      id: "ticket-1",
      type: "TICKET",
      fileName: "ticket.png",
      privateAssetId: "asset-ticket",
      contentType: "image/png",
      declaredSizeBytes: 500,
    },
  ],
};

describe("PassportOcrProcessor partner verification synchronization", () => {
  it("extracts partner passport fields before traveler confirmation", async () => {
    const extractionUpsert = vi.fn();
    const verificationUpdate = vi.fn();
    const extractFirst = {
      ...verification,
      mode: "EXTRACT_FIRST",
      travelerSnapshot: null,
    };
    const tx = {
      partnerDocumentVerification: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ travelerSnapshot: null, status: "PROCESSING" }),
        update: verificationUpdate,
      },
      passportExtraction: { upsert: extractionUpsert },
    };
    const prisma = {
      partnerDocumentVerification: {
        findUnique: vi.fn().mockResolvedValue(extractFirst),
        update: vi.fn().mockResolvedValue({}),
      },
      partnerDocumentUploadIntent: { update: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const result = {
      status: "PARTIAL",
      fields: { firstName: "Test", surname: "Traveler" },
      fieldsRequiringInput: ["nationality"],
      method: "tesseract-ocr",
      checkedAt: new Date().toISOString(),
    };
    const instance = processor(prisma, result);

    await expect(
      instance.process({
        data: { verificationId: "verification-1" },
        attemptsMade: 0,
        opts: { attempts: 1 },
      } as never),
    ).resolves.toEqual(result);
    expect(extractionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          partnerVerificationId: "verification-1",
          status: "PARTIAL",
        }),
      }),
    );
    expect(verificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AWAITING_TRAVELER_CONFIRMATION",
        }),
      }),
    );
  });

  it("does not overwrite a manual decision that wins the OCR race", async () => {
    const intentUpdate = vi.fn();
    const orderUpdate = vi.fn();
    const tx = {
      partnerDocumentUploadIntent: { update: intentUpdate },
      partnerDocumentVerification: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn(),
      },
      order: { updateMany: orderUpdate },
      travelerDocument: { updateMany: vi.fn() },
    };
    const prisma = {
      partnerDocumentVerification: {
        findUnique: vi.fn().mockResolvedValue(verification),
        update: vi.fn().mockResolvedValue({}),
      },
      partnerDocumentUploadIntent: { update: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const instance = processor(prisma, {
      status: "VERIFIED",
      method: "ocr",
      matchedFields: ["passportNumber"],
      confidence: 0.99,
      checkedAt: new Date().toISOString(),
    });

    await expect(
      instance.process({
        data: { verificationId: "verification-1" },
        attemptsMade: 0,
        opts: { attempts: 1 },
      } as never),
    ).resolves.toEqual({ skipped: true, reviewAlreadyDecided: true });
    expect(intentUpdate).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(prisma.partnerEvent.create).not.toHaveBeenCalled();
  });

  it("updates an order linked after the OCR job loaded its verification", async () => {
    const orderUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      partnerDocumentUploadIntent: { update: vi.fn() },
      partnerDocumentVerification: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ consumedOrderId: "order-1" }),
      },
      order: { updateMany: orderUpdate },
      travelerDocument: { updateMany: vi.fn() },
    };
    const prisma = {
      partnerDocumentVerification: {
        findUnique: vi.fn().mockResolvedValue(verification),
        update: vi.fn().mockResolvedValue({}),
      },
      partnerDocumentUploadIntent: { update: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const instance = processor(prisma, {
      status: "VERIFIED",
      method: "ocr",
      matchedFields: ["passportNumber"],
      confidence: 0.99,
      checkedAt: new Date().toISOString(),
    });

    await instance.process({
      data: { verificationId: "verification-1" },
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as never);

    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "order-1" }),
        data: expect.objectContaining({
          status: "REVIEW_PENDING",
          documentReviewStatus: "VERIFIED",
        }),
      }),
    );
  });

  it("uses a consistent recoverable re-upload state", async () => {
    const verificationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const orderUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const intentUpdate = vi.fn();
    const tx = {
      partnerDocumentUploadIntent: { update: intentUpdate },
      partnerDocumentVerification: {
        updateMany: verificationUpdate,
        findUnique: vi.fn().mockResolvedValue({ consumedOrderId: "order-1" }),
      },
      order: { updateMany: orderUpdate },
      travelerDocument: { updateMany: vi.fn() },
    };
    const prisma = {
      partnerDocumentVerification: {
        findUnique: vi.fn().mockResolvedValue(verification),
        update: vi.fn().mockResolvedValue({}),
      },
      partnerDocumentUploadIntent: { update: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const instance = processor(prisma, {
      status: "FAILED",
      method: "ocr",
      matchedFields: [],
      confidence: 0,
      checkedAt: new Date().toISOString(),
    });

    await instance.process({
      data: { verificationId: "verification-1" },
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as never);

    expect(intentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationStatus: "REUPLOAD_REQUIRED",
        }),
      }),
    );
    expect(verificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "verification-1",
          status: {
            in: ["AWAITING_UPLOAD", "PROCESSING", "PROCESSING_BACKGROUND"],
          },
        }),
        data: {
          status: "REUPLOAD_REQUIRED",
          failureCode: "PASSPORT_REUPLOAD_REQUIRED",
        },
      }),
    );
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AWAITING_CUSTOMER",
          documentReviewStatus: "REUPLOAD_REQUIRED",
        }),
      }),
    );
  });
});

it("ignores an OCR job for a replaced passport asset", async () => {
  const tx = vi.fn();
  const instance = processor(
    {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order",
          documentReviewStatus: "OCR_PENDING",
          documents: [
            {
              id: "passport",
              type: "PASSPORT",
              privateAssetId: "new-asset",
              uploadVerified: true,
            },
          ],
        }),
      },
      $transaction: tx,
    },
    {},
  );
  await expect(
    instance.process({
      data: {
        orderId: "order",
        documentId: "passport",
        privateAssetId: "old-asset",
      },
    } as never),
  ).resolves.toMatchObject({ skipped: true, supersededUpload: true });
  expect(tx).not.toHaveBeenCalled();
});
