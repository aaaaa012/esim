import {
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
import { randomUUID } from "node:crypto";

const MAX_CAMPAIGN_BYTES = 3 * 1024 * 1024;
const CAMPAIGN_PREFIX = "visa-compass/public/homepage-promotions/";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

export type CampaignImageFormat = "PORTRAIT" | "SQUARE" | "LANDSCAPE";

export type PresignedCampaignUpload = {
  assetKey: string;
  upload: {
    mode: "s3-presigned";
    endpoint: string;
    method: "PUT";
    headers: Record<string, string>;
    expiresInSeconds: number;
  };
};

@Injectable()
export class PublicAssetStorageService {
  async createCampaignUpload(
    contentType: string,
  ): Promise<PresignedCampaignUpload> {
    const normalized = this.requireAllowedType(contentType);
    this.requireConfigured();
    const extension = normalized === "image/png" ? "png" : "jpg";
    const assetKey = `${CAMPAIGN_PREFIX}campaign_${randomUUID()}.${extension}`;
    try {
      const endpoint = await getSignedUrl(
        this.client(),
        new PutObjectCommand({
          Bucket: this.bucket(),
          Key: assetKey,
          ContentType: normalized,
          CacheControl: "public, max-age=31536000, immutable",
        }),
        {
          expiresIn: 600,
          signableHeaders: new Set(["content-type"]),
        },
      );
      return {
        assetKey,
        upload: {
          mode: "s3-presigned",
          endpoint,
          method: "PUT",
          headers: { "content-type": normalized },
          expiresInSeconds: 600,
        },
      };
    } catch {
      throw new ServiceUnavailableException(
        "Campaign image upload authorization failed",
      );
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
        throw new BadRequestException(
          "Campaign artwork must be a JPG or PNG up to 3 MB",
        );
      const contentType = this.requireAllowedType(head.ContentType ?? "");
      const prefix = await this.client().send(
        new GetObjectCommand({
          Bucket: this.bucket(),
          Key: assetKey,
          Range: "bytes=0-131071",
        }),
      );
      const image = this.inspectImage(await this.bodyToBuffer(prefix.Body));
      if (
        (contentType === "image/png" && image.kind !== "png") ||
        (contentType === "image/jpeg" && image.kind !== "jpg")
      )
        throw new BadRequestException(
          "Campaign artwork content does not match its file type",
        );
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
      throw new BadRequestException(
        "Campaign image upload could not be verified",
      );
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
      process.env.AWS_PUBLIC_ASSET_BUCKET &&
      process.env.PUBLIC_ASSET_BASE_URL,
    );
  }

  publicUrl(assetKey: string) {
    this.requireCampaignKey(assetKey);
    const base = process.env.PUBLIC_ASSET_BASE_URL?.replace(/\/+$/, "");
    if (!base)
      throw new ServiceUnavailableException(
        "Public campaign asset storage is not configured",
      );
    return `${base}/${assetKey
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
  }

  private displayFormat(width: number, height: number): CampaignImageFormat {
    if (width < 320 || height < 320)
      throw new BadRequestException(
        "Campaign artwork must be at least 320 pixels in each direction",
      );
    const ratio = width / height;
    if (ratio < 0.45 || ratio > 3.6)
      throw new BadRequestException(
        "Campaign artwork has an unsupported ratio",
      );
    if (ratio > 1.35) return "LANDSCAPE";
    if (ratio < 0.85) return "PORTRAIT";
    return "SQUARE";
  }

  private inspectImage(bytes: Buffer): {
    kind: "jpg" | "png";
    width: number;
    height: number;
  } {
    if (
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes.subarray(1, 4).toString("ascii") === "PNG"
    ) {
      return {
        kind: "png",
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      };
    }
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
      if (sof.has(marker)) {
        return {
          kind: "jpg",
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += length;
    }
    throw new BadRequestException(
      "Campaign artwork dimensions could not be read",
    );
  }

  private requireCampaignKey(assetKey: string) {
    if (
      !assetKey.startsWith(CAMPAIGN_PREFIX) ||
      assetKey.includes("..") ||
      !/^[a-zA-Z0-9_./-]+$/.test(assetKey)
    )
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
      throw new ServiceUnavailableException(
        "Public campaign asset storage is not configured",
      );
  }

  private client() {
    this.requireConfigured();
    return new S3Client({
      region: process.env.AWS_REGION!,
      ...(process.env.AWS_S3_ENDPOINT
        ? { endpoint: process.env.AWS_S3_ENDPOINT }
        : {}),
      ...(process.env.AWS_S3_FORCE_PATH_STYLE === "true"
        ? { forcePathStyle: true }
        : {}),
    });
  }

  private bucket() {
    this.requireConfigured();
    return process.env.AWS_PUBLIC_ASSET_BUCKET!;
  }

  private async bodyToBuffer(body: unknown): Promise<Buffer> {
    if (!body || typeof body !== "object")
      throw new BadRequestException("Campaign artwork could not be read");
    if (
      "transformToByteArray" in body &&
      typeof body.transformToByteArray === "function"
    ) {
      return Buffer.from(await body.transformToByteArray());
    }
    if (
      Symbol.asyncIterator in body &&
      typeof body[Symbol.asyncIterator] === "function"
    ) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > 132 * 1024)
          throw new BadRequestException("Campaign artwork could not be read");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new BadRequestException("Campaign artwork could not be read");
  }
}
