import { describe, expect, it, vi } from "vitest";
import { PassportOcrProcessor } from "./passport-ocr.processor.js";

function processor(
  prisma: Record<string, unknown>,
  result: Record<string, unknown>,
  ticketInspection: Record<string, unknown> = {
    status: "VALID",
    detail: "Travel-ticket evidence detected",
  },
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
      inspectTravelTicket: vi.fn().mockResolvedValue(ticketInspection),
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
  it("validates a travel ticket on basic upload evidence without OCR", async () => {
    const intentUpdate = vi.fn().mockResolvedValue({});
    const verificationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      partnerDocumentUploadIntent: { update: vi.fn() },
      partnerDocumentVerification: {
        updateMany: verificationUpdate,
        findUnique: vi.fn().mockResolvedValue({ consumedOrderId: null }),
      },
      order: { updateMany: vi.fn() },
      travelerDocument: { updateMany: vi.fn() },
    };
    const prisma = {
      partnerDocumentVerification: {
        findUnique: vi.fn().mockResolvedValue(verification),
        update: vi.fn().mockResolvedValue({}),
      },
      partnerDocumentUploadIntent: { update: intentUpdate },
      $transaction: vi.fn((callback) => callback(tx)),
      partnerWebhookEndpoint: { findMany: vi.fn().mockResolvedValue([]) },
      partnerEvent: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const inspectTravelTicket = vi.fn();
    const instance = new PassportOcrProcessor(
      { registerWorker: vi.fn() } as never,
      prisma as never,
      {
        decrypt: vi.fn((value: string) => value),
        encrypt: vi.fn((value: string) => `encrypted:${value}`),
      } as never,
      {
        verify: vi.fn().mockResolvedValue({
          status: "VERIFIED",
          matchedFields: ["passportNumber"],
          confidence: 0.99,
          method: "ocr",
          checkedAt: new Date().toISOString(),
        }),
        extract: vi.fn(),
        inspectTravelTicket,
      } as never,
      {
        verifyDocument: vi.fn().mockResolvedValue({ bytes: 500, format: "png" }),
      } as never,
      { attention: vi.fn(), resolve: vi.fn() } as never,
    );

    await instance.process({
      data: { verificationId: "verification-1" },
      attemptsMade: 0,
      opts: { attempts: 1 },
    } as never);

    expect(inspectTravelTicket).not.toHaveBeenCalled();
    expect(intentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ticket-1" },
        data: expect.objectContaining({ verificationStatus: "VERIFIED" }),
      }),
    );
  });

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
      partnerEvent: { upsert: vi.fn().mockResolvedValue({}) },
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
    expect(prisma.partnerEvent.upsert).not.toHaveBeenCalled();
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
      partnerEvent: { upsert: vi.fn().mockResolvedValue({}) },
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

  it("keeps a comparison mismatch recoverable without forcing re-upload", async () => {
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
      partnerEvent: { upsert: vi.fn().mockResolvedValue({}) },
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
          verificationStatus: "PENDING",
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
          status: "MANUAL_REVIEW",
          failureCode: "TRAVELLER_DETAILS_UNCONFIRMED",
        },
      }),
    );
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "REVIEW_PENDING",
          documentReviewStatus: "MANUAL_REVIEW",
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

it("restores the replacement gate when an expired extraction races with a refresh", async () => {
  const orderUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const documentUpdate = vi.fn().mockResolvedValue({});
  const instance = processor(
    {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "expired-order",
          status: "DRAFT",
          documentReviewStatus: "NOT_STARTED",
          traveler: null,
          passportExtraction: null,
          partner: null,
          documents: [
            {
              id: "passport",
              type: "PASSPORT",
              fileName: "passport.png",
              privateAssetId: "expired-passport-asset",
              uploadVerified: true,
              status: "PENDING",
            },
          ],
        }),
      },
      $transaction: vi.fn((callback) =>
        callback({
          travelerDocument: {
            findUnique: vi.fn().mockResolvedValue({
              privateAssetId: "expired-passport-asset",
              uploadVerified: true,
            }),
            update: documentUpdate,
          },
          passportExtraction: { upsert: vi.fn().mockResolvedValue({}) },
          order: { updateMany: orderUpdate },
        }),
      ),
    },
    {
      status: "MANUAL_ENTRY_REQUIRED",
      fields: { passportExpiryDate: "2020-01-01" },
      fieldsRequiringInput: [],
      method: "tesseract-ocr",
      checkedAt: new Date().toISOString(),
      failureCode: "PASSPORT_EXPIRED",
    },
  );

  await instance.process({
    data: {
      orderId: "expired-order",
      documentId: "passport",
      privateAssetId: "expired-passport-asset",
    },
  } as never);

  expect(orderUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: "expired-order",
        documentReviewStatus: {
          in: [
            "NOT_STARTED",
            "OCR_PENDING",
            "OCR_BACKGROUND",
            "CORRECTION_REQUIRED",
            "REUPLOAD_REQUIRED",
          ],
        },
      }),
      data: expect.objectContaining({
        documentReviewStatus: "REUPLOAD_REQUIRED",
      }),
    }),
  );
  expect(documentUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: "REUPLOAD_REQUIRED" }),
    }),
  );
});

it("re-approves a replacement ticket and replays a terminal passport verdict", async () => {
  const orderUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const ticketUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const eventCreate = vi.fn();
  const instance = processor(
    {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order",
          status: "REVIEW_PENDING",
          documentReviewStatus: "REUPLOAD_REQUIRED",
          documents: [
            {
              id: "passport",
              type: "PASSPORT",
              privateAssetId: "passport-asset",
              uploadVerified: true,
              passportVerificationStatus: "VERIFIED",
            },
            {
              id: "ticket",
              type: "TICKET",
              privateAssetId: "ticket-asset",
              uploadVerified: true,
              status: "PENDING",
            },
          ],
        }),
      },
      travelerDocument: { updateMany: ticketUpdate },
      $transaction: vi.fn((callback) =>
        callback({
          order: { updateMany: orderUpdate },
          orderEvent: { create: eventCreate },
        }),
      ),
    },
    {},
  );

  await expect(
    instance.process({
      data: {
        orderId: "order",
        documentId: "passport",
        privateAssetId: "passport-asset",
      },
    } as never),
  ).resolves.toEqual({
    status: "VERIFIED",
    documentType: "TICKET",
    ticketRevalidated: true,
  });
  expect(ticketUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: "ticket",
        privateAssetId: "ticket-asset",
        status: "PENDING",
      }),
      data: expect.objectContaining({ status: "APPROVED" }),
    }),
  );
  expect(orderUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ documentReviewStatus: "VERIFIED" }),
    }),
  );
  expect(eventCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ orderId: "order" }),
    }),
  );
});

it("does not approve a ticket that was replaced during the run", async () => {
  const orderUpdate = vi.fn();
  const ticketUpdate = vi.fn().mockResolvedValue({ count: 0 });
  const instance = processor(
    {
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: "order",
          status: "REVIEW_PENDING",
          documentReviewStatus: "REUPLOAD_REQUIRED",
          documents: [
            {
              id: "passport",
              type: "PASSPORT",
              privateAssetId: "passport-asset",
              uploadVerified: true,
              passportVerificationStatus: "VERIFIED",
            },
            {
              id: "ticket",
              type: "TICKET",
              privateAssetId: "old-ticket-asset",
              uploadVerified: true,
              status: "PENDING",
            },
          ],
        }),
      },
      travelerDocument: { updateMany: ticketUpdate },
      $transaction: vi.fn((callback) =>
        callback({
          order: { updateMany: orderUpdate },
          orderEvent: { create: vi.fn() },
        }),
      ),
    },
    {},
  );

  await expect(
    instance.process({
      data: {
        orderId: "order",
        documentId: "passport",
        privateAssetId: "passport-asset",
      },
    } as never),
  ).resolves.toEqual({ skipped: true, supersededTicketUpload: true });
  expect(orderUpdate).not.toHaveBeenCalled();
});
