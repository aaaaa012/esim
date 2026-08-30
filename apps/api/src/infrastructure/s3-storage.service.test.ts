import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, getSignedUrlMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: unknown) {}
  }
  return {
    S3Client: class {
      send = sendMock;
    },
    PutObjectCommand: class PutObjectCommand extends Command {},
    HeadObjectCommand: class HeadObjectCommand extends Command {},
    GetObjectCommand: class GetObjectCommand extends Command {},
    DeleteObjectCommand: class DeleteObjectCommand extends Command {},
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

import { BadRequestException } from "@nestjs/common";
import { DocumentType } from "@visa-compass/shared";
import { S3StorageService } from "./s3-storage.service.js";

describe("S3StorageService", () => {
  beforeEach(() => {
    sendMock.mockReset();
    getSignedUrlMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns a local simulator authorization outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_S3_BUCKET", "");

    const result = await new S3StorageService().createDocumentUpload(
      "order-1",
      DocumentType.PASSPORT,
      "application/pdf",
    );

    expect(result.upload.mode).toBe("local-simulator");
    expect(result.assetId).toContain(
      "visa-compass/private/orders/order-1/passport-doc_",
    );
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it("creates a content-type-bound presigned S3 PUT", async () => {
    vi.stubEnv("AWS_REGION", "ap-south-1");
    vi.stubEnv("AWS_S3_BUCKET", "private-documents");
    getSignedUrlMock.mockResolvedValue("https://signed.example/upload");

    const result = await new S3StorageService().createDocumentUpload(
      "order-1",
      DocumentType.PASSPORT,
      "image/png",
    );

    expect(result.upload).toEqual({
      mode: "s3-presigned",
      endpoint: "https://signed.example/upload",
      method: "PUT",
      headers: { "content-type": "image/png" },
      expiresInSeconds: 600,
    });
    const command = getSignedUrlMock.mock.calls[0]?.[1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toEqual(
      expect.objectContaining({
        Bucket: "private-documents",
        ContentType: "image/png",
      }),
    );
  });

  it("verifies size, declared type, and actual file signature", async () => {
    vi.stubEnv("AWS_REGION", "ap-south-1");
    vi.stubEnv("AWS_S3_BUCKET", "private-documents");
    sendMock
      .mockResolvedValueOnce({
        ContentLength: 120,
        ContentType: "application/pdf",
      })
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () =>
            Uint8Array.from(Buffer.from("%PDF-1.7\n")),
        },
      });

    await expect(
      new S3StorageService().verifyDocument("private/order/passport"),
    ).resolves.toEqual({ bytes: 120, format: "pdf" });
  });

  it("rejects a file whose bytes do not match its content type", async () => {
    vi.stubEnv("AWS_REGION", "ap-south-1");
    vi.stubEnv("AWS_S3_BUCKET", "private-documents");
    sendMock
      .mockResolvedValueOnce({
        ContentLength: 120,
        ContentType: "image/png",
      })
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () =>
            Uint8Array.from(Buffer.from("%PDF-1.7\n")),
        },
      });

    await expect(
      new S3StorageService().verifyDocument("private/order/passport"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
