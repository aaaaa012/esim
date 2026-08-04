import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

@Injectable()
export class CryptoService {
  private key() {
    const configured = process.env.APP_ENCRYPTION_KEY_BASE64;
    if (!configured && process.env.NODE_ENV === 'production') throw new Error('APP_ENCRYPTION_KEY_BASE64 is required');
    return configured ? Buffer.from(configured, 'base64') : Buffer.alloc(32, 7);
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }
  decrypt(value: string) {
    const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part!, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
  }
  blindIndex(value: string) {
    return createHmac('sha256', process.env.PII_HASH_KEY ?? 'development-only').update(value.trim().toUpperCase()).digest('hex');
  }
}
