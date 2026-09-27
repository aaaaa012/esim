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
    CopyObjectCommand: class CopyObjectCommand extends Command {},
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
      headers: {
        "content-type": "image/png",
        "x-amz-server-side-encryption": "AES256",
      },
      expiresInSeconds: 600,
    });
    const command = getSignedUrlMock.mock.calls[0]?.[1] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toEqual(
      expect.objectContaining({
        Bucket: "private-documents",
        ContentType: "image/png",
        ServerSideEncryption: "AES256",
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

  it("copies verified bytes to a content-addressed immutable key", async () => {
    vi.stubEnv("AWS_REGION", "ap-south-1");
    vi.stubEnv("AWS_S3_BUCKET", "private-documents");
    const bytes = Buffer.from("%PDF-1.7\nimmutable-document");
    sendMock
      .mockResolvedValueOnce({
        ContentLength: bytes.length,
        ContentType: "application/pdf",
      })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
      })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
        ContentType: "application/pdf",
      })
      .mockResolvedValueOnce({ VersionId: "version-1" })
      .mockResolvedValueOnce({ ContentLength: bytes.length });

    const result = await new S3StorageService().finalizeDocument(
      "visa-compass/private/orders/order-1/passport-doc_temporary",
    );

    expect(result.finalizedAssetId).toMatch(
      /^visa-compass\/private\/orders\/order-1\/passport\/finalized\/[a-f0-9]{64}\.pdf$/,
    );
    expect(result.storageVersionId).toBe("version-1");
    const copy = sendMock.mock.calls[3]?.[0] as {
      input: Record<string, unknown>;
    };
    expect(copy.input).toEqual(
      expect.objectContaining({
        ServerSideEncryption: "AES256",
        MetadataDirective: "REPLACE",
      }),
    );
  });
});
