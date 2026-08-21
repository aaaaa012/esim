import { beforeEach, describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.service.js';

describe('CryptoService', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
    process.env.PII_HASH_KEY = 'unit-test-blind-index-key';
  });

  it('round-trips an encrypted value', () => {
    const crypto = new CryptoService();
    const payload = 'LPA:1$example.com$SECRET-QR-PAYLOAD';
    const encrypted = crypto.encrypt(payload);
    expect(encrypted).not.toContain(payload);
    expect(crypto.decrypt(encrypted)).toBe(payload);
  });

  it('produces a fresh IV per encryption so identical inputs differ', () => {
    const crypto = new CryptoService();
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
  });

  it('fails closed when the ciphertext is tampered with (GCM auth)', () => {
    const crypto = new CryptoService();
    const encrypted = crypto.encrypt('passport E00007730');
    const parts = encrypted.split('.');
    const data = Buffer.from(parts[2]!, 'base64url');
    data[0] = data[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], data.toString('base64url')].join('.');
    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('rejects malformed ciphertext shapes without throwing crypto internals', () => {
    const crypto = new CryptoService();
    expect(() => crypto.decrypt('not-a-valid-value')).toThrow('Invalid encrypted value');
    expect(() => crypto.decrypt('a.b')).toThrow('Invalid encrypted value');
    expect(() => crypto.decrypt('..')).toThrow('Invalid encrypted value');
  });

  it('builds a stable blind index that ignores case and surrounding whitespace', () => {
    const crypto = new CryptoService();
    const expected = crypto.blindIndex('E00007730');
    expect(crypto.blindIndex('  e00007730 ')).toBe(expected);
    expect(crypto.blindIndex('E00007731')).not.toBe(expected);
  });

  it('refuses to derive keys in production when configuration is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_ENCRYPTION_KEY_BASE64;
    delete process.env.PII_HASH_KEY;
    const crypto = new CryptoService();
    expect(() => crypto.encrypt('x')).toThrow('APP_ENCRYPTION_KEY_BASE64 is required');
    expect(() => crypto.blindIndex('x')).toThrow('PII_HASH_KEY is required in production');
  });
});
