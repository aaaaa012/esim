import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import type { DocumentType } from "@visa-compass/shared";

const execFileAsync = promisify(execFile);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const passportOcrMaxPages = () => {
  const configured = Number(process.env.PASSPORT_OCR_MAX_PAGES ?? 8);
  return Number.isInteger(configured) && configured >= 1 && configured <= 16
    ? configured
    : 8;
};
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

export type PresignedDocumentUpload = {
  assetId: string;
  upload: {
    mode: "s3-presigned" | "local-simulator";
    endpoint?: string;
    method?: "PUT";
    headers?: Record<string, string>;
    expiresInSeconds: number;
  };
};

@Injectable()
export class S3StorageService {
  async finalizeDocument(assetId: string) {
    const verified = await this.verifyDocument(assetId);
    if (!this.isConfigured())
      return {
        temporaryAssetId: assetId,
        finalizedAssetId: assetId,
        sha256: createHash("sha256").update(assetId).digest("hex"),
        byteSize: verified.bytes,
        contentType: "application/pdf",
        storageVersionId: null,
      };
    const downloaded = await this.downloadDocument(assetId);
    const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    const extension =
      verified.format === "pdf"
        ? "pdf"
        : verified.format === "png"
          ? "png"
          : "jpg";
    const finalizedAssetId = `${assetId.replace(/-doc_[^/]+$/, "")}/finalized/${sha256}.${extension}`;
    const copied = await this.client().send(
      new CopyObjectCommand({
        Bucket: this.bucket(),
        Key: finalizedAssetId,
        CopySource: encodeURIComponent(
          `${this.bucket()}/${assetId}`,
        ).replaceAll("%2F", "/"),
        ContentType: downloaded.contentType,
        MetadataDirective: "REPLACE",
        ServerSideEncryption: "AES256",
      }),
    );
    const finalHead = await this.client().send(
      new HeadObjectCommand({ Bucket: this.bucket(), Key: finalizedAssetId }),
    );
    if (Number(finalHead.ContentLength ?? 0) !== downloaded.bytes.length)
      throw new ServiceUnavailableException(
        "Finalized document integrity check failed",
      );
    return {
      temporaryAssetId: assetId,
      finalizedAssetId,
      sha256,
      byteSize: downloaded.bytes.length,
      contentType: downloaded.contentType,
      storageVersionId: copied.VersionId ?? finalHead.VersionId ?? null,
    };
  }

  async createDocumentUpload(
    orderId: string,
    type: DocumentType,
    contentType: string,
  ): Promise<PresignedDocumentUpload> {
    return this.createSignedUpload(
      `visa-compass/private/orders/${orderId}`,
      type,
      contentType,
      600,
    );
  }

  async createPartnerDocumentUpload(
    uploadId: string,
    type: DocumentType,
    contentType: string,
  ): Promise<PresignedDocumentUpload> {
    return this.createSignedUpload(
      `visa-compass/private/partner-uploads/${uploadId}`,
      type,
      contentType,
      900,
    );
  }

  private async createSignedUpload(
    prefix: string,
    type: DocumentType,
    contentType: string,
    expiresInSeconds: number,
  ): Promise<PresignedDocumentUpload> {
    const normalizedContentType = this.requireAllowedContentType(contentType);
    const assetId = `${prefix}/${type.toLowerCase()}-doc_${randomUUID()}`;
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === "production")
        throw new ServiceUnavailableException(
          "Private document storage is not configured",
        );
      return {
        assetId,
        upload: { mode: "local-simulator", expiresInSeconds },
      };
    }

    try {
      const endpoint = await getSignedUrl(
        this.client(),
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: assetId,
          ContentType: normalizedContentType,
          ServerSideEncryption: "AES256",
        }),
        {
          expiresIn: expiresInSeconds,
          signableHeaders: new Set(["content-type"]),
        },
      );
      return {
        assetId,
        upload: {
          mode: "s3-presigned",
          endpoint,
          method: "PUT",
          headers: {
            "content-type": normalizedContentType,
            "x-amz-server-side-encryption": "AES256",
          },
          expiresInSeconds,
        },
      };
    } catch {
      throw new ServiceUnavailableException(
        "Private document storage authorization failed",
      );
    }
  }

  async verifyDocument(assetId: string) {
    if (!this.isConfigured()) {
      return { bytes: 0, format: "pdf", simulated: true };
    }
    try {
      const client = this.client();
      const head = await client.send(
        new HeadObjectCommand({ Bucket: this.bucket(), Key: assetId }),
      );
      const bytes = Number(head.ContentLength ?? 0);
      if (bytes < 1 || bytes > MAX_DOCUMENT_BYTES)
        throw new BadRequestException(
          "Document must be a PDF, JPG or PNG up to 10 MB",
        );

      const prefix = await client.send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: assetId,
          Range: "bytes=0-15",
        }),
      );
      const format = this.detectFormat(await this.bodyToBuffer(prefix.Body));
      const contentType = this.requireAllowedContentType(
        head.ContentType ?? "",
      );
      if (!this.formatMatchesContentType(format, contentType))
        throw new BadRequestException(
          "Document must be a PDF, JPG or PNG up to 10 MB",
        );
      return { bytes, format };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Document upload could not be verified");
    }
  }

  async deleteDocument(assetId: string) {
    if (!this.isConfigured()) return;
    await this.client().send(
      new DeleteObjectCommand({ Bucket: this.bucket(), Key: assetId }),
    );
  }

  async signedReadUrl(assetId: string) {
    if (!this.isConfigured())
      throw new ServiceUnavailableException(
        "Private document storage is not configured",
      );
    try {
      return await getSignedUrl(
        this.client(),
        new GetObjectCommand({ Bucket: this.bucket(), Key: assetId }),
        { expiresIn: 300 },
      );
    } catch {
      throw new ServiceUnavailableException(
        "Private document access authorization failed",
      );
    }
  }

  async downloadDocument(assetId: string) {
    if (!this.isConfigured())
      throw new ServiceUnavailableException(
        "Private document storage is not configured",
      );
    try {
      const response = await this.client().send(
        new GetObjectCommand({ Bucket: this.bucket(), Key: assetId }),
      );
      if (Number(response.ContentLength ?? 0) > MAX_DOCUMENT_BYTES)
        throw new BadRequestException("Document content is unavailable");
      const bytes = await this.bodyToBuffer(response.Body, MAX_DOCUMENT_BYTES);
      if (!bytes.length)
        throw new BadRequestException("Document content is unavailable");
      return {
        bytes,
        contentType: response.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Document content is unavailable");
    }
  }

  async downloadDocumentImage(assetId: string) {
    return (await this.downloadDocumentImages(assetId))[0]!;
  }

  /** Returns every page relevant to document OCR. Passport uploads sometimes
   * contain the cover and information page as a two-page PDF, so examining
   * only page one incorrectly rejects an otherwise valid document. */
  async downloadDocumentImages(assetId: string) {
    const document = await this.downloadDocument(assetId);
    const maxBytes = Number(
      process.env.PASSPORT_OCR_MAX_IMAGE_BYTES ?? 5 * 1024 * 1024,
    );
    const format = this.detectFormat(document.bytes.subarray(0, 16));
    if (format !== "pdf") {
      if (document.bytes.length > maxBytes)
        throw new BadRequestException("Passport image is too large to verify");
      return [
        {
          bytes: document.bytes,
          contentType: format === "png" ? "image/png" : "image/jpeg",
        },
      ];
    }

    const workDir = await mkdtemp(join(tmpdir(), "visa-passport-ocr-"));
    const inputPath = join(workDir, "passport.pdf");
    const outputPrefix = join(workDir, "passport-page");
    try {
      await writeFile(inputPath, document.bytes, { mode: 0o600 });
      await execFileAsync(
        "pdftoppm",
        [
          "-f",
          "1",
          "-l",
          String(passportOcrMaxPages()),
          "-scale-to",
          "2000",
          "-gray",
          "-jpeg",
          inputPath,
          outputPrefix,
        ],
        { timeout: 30_000, maxBuffer: 256 * 1024 },
      );
      const pageNames = (await readdir(workDir))
        .filter((name) => /^passport-page-\d+\.jpg$/i.test(name))
        .sort((left, right) =>
          left.localeCompare(right, undefined, { numeric: true }),
        );
      if (!pageNames.length)
        throw new BadRequestException("Document could not be read as an image");
      const pages = await Promise.all(
        pageNames.map(async (name) => {
          const bytes = await readFile(join(workDir, name));
          if (!bytes.length || bytes.length > maxBytes)
            throw new BadRequestException(
              "Passport image is too large to verify",
            );
          return { bytes, contentType: "image/jpeg" };
        }),
      );
      return pages;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Document could not be read as an image");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  isConfigured() {
    return Boolean(process.env.AWS_REGION && process.env.AWS_S3_BUCKET);
  }

  private client() {
    const region = process.env.AWS_REGION;
    if (!region || !process.env.AWS_S3_BUCKET)
      throw new ServiceUnavailableException(
        "Private document storage is not configured",
      );
    return new S3Client({
      region,
      ...(process.env.AWS_S3_ENDPOINT
        ? { endpoint: process.env.AWS_S3_ENDPOINT }
        : {}),
      ...(process.env.AWS_S3_FORCE_PATH_STYLE === "true"
        ? { forcePathStyle: true }
        : {}),
    });
  }

  private bucket() {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket)
      throw new ServiceUnavailableException(
        "Private document storage is not configured",
      );
    return bucket;
  }

  private requireAllowedContentType(contentType: string) {
    const normalized = contentType.toLowerCase().split(";", 1)[0]!.trim();
    if (!ALLOWED_CONTENT_TYPES.has(normalized))
      throw new BadRequestException("Document must be a PDF, JPG or PNG");
    return normalized;
  }

  private detectFormat(bytes: Uint8Array): "pdf" | "jpg" | "png" {
    if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-")
      return "pdf";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return "jpg";
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    )
      return "png";
    throw new BadRequestException("Document must be a PDF, JPG or PNG");
  }

  private formatMatchesContentType(format: string, contentType: string) {
    return (
      (format === "pdf" && contentType === "application/pdf") ||
      (format === "jpg" && contentType === "image/jpeg") ||
      (format === "png" && contentType === "image/png")
    );
  }

  private async bodyToBuffer(
    body: unknown,
    maxBytes = 64 * 1024,
  ): Promise<Buffer> {
    if (!body || typeof body !== "object")
      throw new BadRequestException("Document content is unavailable");
    if (
      Symbol.asyncIterator in body &&
      typeof body[Symbol.asyncIterator] === "function"
    ) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes)
          throw new BadRequestException("Document content is unavailable");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (
      "transformToByteArray" in body &&
      typeof body.transformToByteArray === "function"
    ) {
      const bytes = Buffer.from(
        await (body.transformToByteArray as () => Promise<Uint8Array>)(),
      );
      if (bytes.length > maxBytes)
        throw new BadRequestException("Document content is unavailable");
      return bytes;
    }
    throw new BadRequestException("Document content is unavailable");
  }
}
