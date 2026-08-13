import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import type { DocumentType } from '@visa-compass/shared';

export type SignedDocumentUpload = {
  assetId: string;
  upload: { mode: 'cloudinary-signed' | 'local-simulator'; endpoint?: string; cloudName?: string; apiKey?: string; publicId?: string; deliveryType?: 'authenticated'; timestamp: number; signature: string; folder: string; expiresInSeconds: number };
};

@Injectable()
export class CloudinaryStorageService {
  createDocumentUpload(orderId: string, type: DocumentType): SignedDocumentUpload {
    return this.createSignedUpload(`visa-compass/private/orders/${orderId}`, type);
  }

  createPartnerDocumentUpload(uploadId: string, type: DocumentType): SignedDocumentUpload {
    return this.createSignedUpload(`visa-compass/private/partner-uploads/${uploadId}`, type, 900);
  }

  private createSignedUpload(folder: string, type: DocumentType, expiresInSeconds = 600): SignedDocumentUpload {
    const assetId = `doc_${randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const configured = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
    if (!configured) {
      if (process.env.NODE_ENV === "production")
        throw new ServiceUnavailableException('Private document storage is not configured');
      return { assetId, upload: { mode: 'local-simulator', timestamp, signature: createHash('sha256').update(`${assetId}:${timestamp}`).digest('hex'), folder, expiresInSeconds } };
    }
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
    const apiKey = process.env.CLOUDINARY_API_KEY!;
    const apiSecret = process.env.CLOUDINARY_API_SECRET!;
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    const publicId = `${type.toLowerCase()}-${assetId}`;
    const signature = cloudinary.utils.api_sign_request({ timestamp, folder, public_id: publicId, type: 'authenticated' }, apiSecret);
    return { assetId: `${folder}/${publicId}`, upload: { mode: 'cloudinary-signed', endpoint: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, cloudName, apiKey, publicId, deliveryType: 'authenticated', timestamp, signature, folder, expiresInSeconds } };
  }

  async verifyDocument(assetId: string) {
    if (!this.isConfigured()) {
      return { bytes: 0, format: 'pdf', simulated: true };
    }
    this.configure();
    try {
      const resource = await cloudinary.api.resource(assetId, { type: 'authenticated', resource_type: 'image' }) as { bytes?: number; format?: string };
      const allowed = ['pdf', 'jpg', 'jpeg', 'png'];
      if (!resource.bytes || resource.bytes > 10 * 1024 * 1024 || !resource.format || !allowed.includes(resource.format.toLowerCase())) throw new BadRequestException('Document must be a PDF, JPG or PNG up to 10 MB');
      return { bytes: resource.bytes, format: resource.format };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Document upload could not be verified');
    }
  }

  signedReadUrl(assetId: string) {
    if (!this.isConfigured()) throw new ServiceUnavailableException('Private document storage is not configured');
    this.configure();
    return cloudinary.url(assetId, { type: 'authenticated', resource_type: 'image', sign_url: true, secure: true, expires_at: Math.floor(Date.now() / 1000) + 300 });
  }

  async downloadDocument(assetId: string) {
    if (!this.isConfigured()) throw new ServiceUnavailableException('Private document storage is not configured');
    const response = await fetch(this.signedReadUrl(assetId));
    if (!response.ok) throw new BadRequestException('Document content is unavailable');
    return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /**
   * Downloads the document rasterized as a single JPEG image so OCR can read
   * it. PDFs are converted to their first page image by Cloudinary (the same
   * transformation the provider applies when an image is requested with a
   * `.jpg` extension); JPG/PNG uploads are re-encoded as JPEG unchanged.
   */
  async downloadDocumentImage(assetId: string) {
    if (!this.isConfigured()) throw new ServiceUnavailableException('Private document storage is not configured');
    this.configure();
    const url = cloudinary.url(assetId, { type: 'authenticated', resource_type: 'image', format: 'jpg', page: 1, sign_url: true, secure: true, expires_at: Math.floor(Date.now() / 1000) + 300 });
    const response = await fetch(url);
    if (!response.ok) throw new BadRequestException('Document content is unavailable');
    const maxBytes = Number(process.env.PASSPORT_OCR_MAX_IMAGE_BYTES ?? 5 * 1024 * 1024);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new BadRequestException('Passport image is too large to verify');
    if (!response.body) throw new BadRequestException('Document could not be read as an image');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BadRequestException('Passport image is too large to verify');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) throw new BadRequestException('Document could not be read as an image');
    return { bytes, contentType: 'image/jpeg' };
  }

  isConfigured() { return Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET); }

  private configure() {
    const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = process.env;
    if (!cloudName || !apiKey || !apiSecret) throw new ServiceUnavailableException('Private document storage is not configured');
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  }
}
