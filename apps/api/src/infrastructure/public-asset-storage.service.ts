import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { ApiException } from "../common/api-error.js";

const MAX_CAMPAIGN_BYTES = 3 * 1024 * 1024;
const CAMPAIGN_PREFIX = "visa-compass/marketing/campaigns/";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_UPLOAD_TYPES = new Set(["image/jpeg", "image/png"]);
const FILE_NAME_PATTERN = /^campaign_[a-z0-9_-]{12,140}\.(?:jpg|png|webp)$/;

export type CampaignImageFormat = "PORTRAIT" | "SQUARE" | "LANDSCAPE";
export type UploadedCampaignAsset = {
  assetKey: string;
  imageUrl: string;
  bytes: number;
  contentType: string;
  width: number;
  height: number;
  format: CampaignImageFormat;
};
type UploadedFile = { buffer: Buffer; mimetype: string; size: number };

@Injectable()
export class PublicAssetStorageService {
  async uploadCampaignAsset(file: UploadedFile): Promise<UploadedCampaignAsset> {
    this.requireConfigured();
    if (!file?.buffer?.length || file.size < 1 || file.size > MAX_CAMPAIGN_BYTES)
      throw new BadRequestException("Campaign artwork must be a JPG or PNG up to 3 MB");
    const contentType = this.requireAllowedType(file.mimetype);
    if (!ALLOWED_UPLOAD_TYPES.has(contentType))
      throw new BadRequestException("Campaign artwork must be a JPG or PNG");
    const image = this.inspectImage(file.buffer);
    if (
      (contentType === "image/png" && image.kind !== "png") ||
      (contentType === "image/jpeg" && image.kind !== "jpg")
    )
      throw new BadRequestException("Campaign artwork content does not match its file type");
    const format = this.displayFormat(image.width, image.height);
    const extension = image.kind === "png" ? "png" : "jpg";
    const digest = createHash("sha256").update(file.buffer).digest("hex").slice(0, 12);
    const fileName = `campaign_${digest}_${randomUUID()}.${extension}`;
    const assetKey = `${CAMPAIGN_PREFIX}${fileName}`;
    try {
      await this.client().send(
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: assetKey,
          Body: file.buffer,
          ContentType: contentType,
          ContentLength: file.size,
          CacheControl: "public, max-age=31536000, immutable",
          Metadata: {
            width: String(image.width),
            height: String(image.height),
            sha256: digest,
          },
        }),
      );
      return {
        assetKey,
        imageUrl: this.publicUrl(assetKey),
        bytes: file.size,
        contentType,
        width: image.width,
        height: image.height,
        format,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw this.storageUnavailable(error);
    }
  }

  async verifyCampaignAsset(assetKey: string) {
    this.requireCampaignKey(assetKey);
    this.requireConfigured();
    try {
      const head = await this.client().send(
        new HeadObjectCommand({ Bucket: this.bucket(), Key: assetKey }),
      );
      const bytes = Number(head.ContentLength ?? 0);
      if (bytes < 1 || bytes > MAX_CAMPAIGN_BYTES)
        throw new BadRequestException("Campaign artwork must be a JPG or PNG up to 3 MB");
      const contentType = this.requireAllowedType(head.ContentType ?? "");
      const prefix = await this.client().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: assetKey,
          Range: "bytes=0-131071",
        }),
      );
      const image = this.inspectImage(await this.bodyToBuffer(prefix.Body, 132 * 1024));
      if (
        (contentType === "image/png" && image.kind !== "png") ||
        (contentType === "image/jpeg" && image.kind !== "jpg")
      )
        throw new BadRequestException("Campaign artwork content does not match its file type");
      return {
        bytes,
        contentType,
        width: image.width,
        height: image.height,
        format: this.displayFormat(image.width, image.height),
        imageUrl: this.publicUrl(assetKey),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Campaign artwork could not be verified");
    }
  }

  async readCampaignAsset(fileName: string) {
    if (!FILE_NAME_PATTERN.test(fileName))
      throw new NotFoundException("Campaign artwork not found");
    this.requireConfigured();
    try {
      const response = await this.client().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: `${CAMPAIGN_PREFIX}${fileName}`,
        }),
      );
      const bytes = await this.bodyToBuffer(response.Body, MAX_CAMPAIGN_BYTES);
      if (!bytes.length) throw new NotFoundException("Campaign artwork not found");
      return {
        bytes,
        contentType: this.requireAllowedType(response.ContentType ?? ""),
        etag: response.ETag ?? `"${createHash("sha256").update(bytes).digest("hex")}"`,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new NotFoundException("Campaign artwork not found");
    }
  }

  async deleteCampaignAsset(assetKey: string) {
    this.requireCampaignKey(assetKey);
    if (!this.isConfigured()) return;
    await this.client().send(
      new DeleteObjectCommand({ Bucket: this.bucket(), Key: assetKey }),
    );
  }

  isConfigured() {
    return Boolean(
      process.env.AWS_REGION &&
        (process.env.AWS_MARKETING_ASSET_BUCKET || process.env.AWS_S3_BUCKET),
    );
  }

  publicUrl(assetKey: string) {
    this.requireCampaignKey(assetKey);
    const fileName = assetKey.slice(CAMPAIGN_PREFIX.length);
    const base = process.env.PUBLIC_ASSET_BASE_URL?.replace(/\/+$/, "");
    return base
      ? `${base}/${encodeURIComponent(fileName)}`
      : `/api/v1/public/marketing-assets/${encodeURIComponent(fileName)}`;
  }

  private displayFormat(width: number, height: number): CampaignImageFormat {
    if (width < 320 || height < 320)
      throw new BadRequestException("Campaign artwork must be at least 320 pixels in each direction");
    const ratio = width / height;
    if (ratio < 0.45 || ratio > 3.6)
      throw new BadRequestException("Campaign artwork has an unsupported ratio");
    if (ratio > 1.35) return "LANDSCAPE";
    if (ratio < 0.85) return "PORTRAIT";
    return "SQUARE";
  }

  private inspectImage(bytes: Buffer): { kind: "jpg" | "png"; width: number; height: number } {
    if (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes.subarray(1, 4).toString("ascii") === "PNG"
    )
      return { kind: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
      throw new BadRequestException("Campaign artwork must be a JPG or PNG");
    let offset = 2;
    const sof = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (sof.has(marker))
        return {
          kind: "jpg",
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      offset += length;
    }
    throw new BadRequestException("Campaign artwork dimensions could not be read");
  }

  private requireCampaignKey(assetKey: string) {
    const fileName = assetKey.startsWith(CAMPAIGN_PREFIX)
      ? assetKey.slice(CAMPAIGN_PREFIX.length)
      : "";
    if (!FILE_NAME_PATTERN.test(fileName))
      throw new BadRequestException("Invalid campaign asset key");
  }

  private requireAllowedType(contentType: string) {
    const normalized = contentType.toLowerCase().split(";", 1)[0]!.trim();
    if (!ALLOWED_TYPES.has(normalized))
      throw new BadRequestException("Campaign artwork must be a JPG or PNG");
    return normalized;
  }

  private requireConfigured() {
    if (!this.isConfigured())
      throw this.storageUnavailable("AWS marketing storage is not configured");
  }

  private client() {
    this.requireConfigured();
    return new S3Client({
      region: process.env.AWS_REGION!,
      ...(process.env.AWS_S3_ENDPOINT ? { endpoint: process.env.AWS_S3_ENDPOINT } : {}),
      ...(process.env.AWS_S3_FORCE_PATH_STYLE === "true" ? { forcePathStyle: true } : {}),
    });
  }

  private bucket() {
    const bucket = process.env.AWS_MARKETING_ASSET_BUCKET ?? process.env.AWS_S3_BUCKET;
    if (!bucket) throw this.storageUnavailable("Marketing bucket is missing");
    return bucket;
  }

  private storageUnavailable(details: unknown) {
    return new ApiException({
      code: "CAMPAIGN_STORAGE_UNAVAILABLE",
      message:
        "Campaign artwork storage is unavailable. Contact an administrator and quote the request reference.",
      status: 503,
      details,
    });
  }

  private async bodyToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
    if (!body || typeof body !== "object")
      throw new BadRequestException("Campaign artwork could not be read");
    if ("transformToByteArray" in body && typeof body.transformToByteArray === "function") {
      const bytes = Buffer.from(await body.transformToByteArray());
      if (bytes.length > maxBytes) throw new BadRequestException("Campaign artwork is too large");
      return bytes;
    }
    if (Symbol.asyncIterator in body && typeof body[Symbol.asyncIterator] === "function") {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new BadRequestException("Campaign artwork is too large");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new BadRequestException("Campaign artwork could not be read");
  }
}
