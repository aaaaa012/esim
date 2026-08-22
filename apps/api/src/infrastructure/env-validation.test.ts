import { beforeEach, describe, expect, it } from 'vitest';
import { validateEnv } from './env-validation.js';

const validProductionEnv = {
  NODE_ENV: 'production',
  API_PUBLIC_URL: 'https://api.visacompass.example',
  CUSTOMER_WEB_URL: 'https://visacompass.example',
  OPS_WEB_URL: 'https://ops.visacompass.example',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:26257/defaultdb?sslmode=verify-full',
  DIRECT_DATABASE_URL: 'postgresql://user:pass@db.example.com:26257/defaultdb?sslmode=verify-full',
  PERSISTENCE_MODE: 'prisma',
  REDIS_URL: 'rediss://cache.example.com:6379',
  APP_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'),
  PII_HASH_KEY: 'a-sufficiently-long-pii-hash-key-value',
  CLERK_SECRET_KEY: 'sk_test_clerk_secret',
  CLERK_WEBHOOK_SECRET: 'whsec_clerk_webhook_secret_value',
  BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@visacompass.example',
  BOOTSTRAP_SUPER_ADMIN_TOKEN: 'bootstrap-token-with-length-over-32-chars',
  GUEST_ORDER_SECRET: 'guest-order-secret-with-length-over-32',
  OPS_ALERT_EMAIL: 'ops@visacompass.example',
  PAYMENT_MODE: 'khalti',
  PAYMENT_WEBHOOK_SECRET: 'khalti-webhook-secret-value-16+',
  KHALTI_SECRET_KEY: 'live_khalti_secret',
  KHALTI_BASE_URL: 'https://khalti.com/api/v2',
  TRANSATEL_COS: 'COS-LIVE',
  CONNECTIVITY_PROVIDER: 'transatel',
  TRANSATEL_BASE_URL: 'https://api.transatel.example',
  TRANSATEL_CLIENT_ID: 'client',
  TRANSATEL_CLIENT_SECRET: 'secret',
  TRANSATEL_MVNO_REF: 'MVNO-1',
  TRANSATEL_WEBHOOK_TARGET_URL: 'https://api.visacompass.example/api/v1/webhooks/transatel',
  TRANSATEL_WEBHOOK_SECRET: 'transatel-webhook-secret-16+',
  NOTIFICATION_MODE: 'live',
  EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 're_live_key',
  EMAIL_FROM_ADDRESS: 'noreply@visacompass.example',
  EMAIL_FROM_NAME: 'Visa Compass',
  CLOUDINARY_CLOUD_NAME: 'cloud',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
  TRUST_PROXY: '1',
  ORDER_WORKFLOW_MODE: 'database-first',
};

describe('validateEnv production gate', () => {
  beforeEach(() => { delete process.env.NODE_ENV; });

  it('accepts a complete production configuration', () => {
    expect(() => validateEnv({ ...validProductionEnv })).not.toThrow();
  });

  it('rejects production when critical secrets are missing and names them', () => {
    const incomplete = { ...validProductionEnv } as Record<string, unknown>;
    delete incomplete.DATABASE_URL;
    delete incomplete.GUEST_ORDER_SECRET;
    delete incomplete.OPS_ALERT_EMAIL;
    let message = '';
    try { validateEnv(incomplete); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('GUEST_ORDER_SECRET');
    expect(message).toContain('OPS_ALERT_EMAIL');
  });

  it('refuses localhost URLs in production', () => {
    const local = { ...validProductionEnv, CUSTOMER_WEB_URL: 'http://localhost:3000' };
    expect(() => validateEnv(local)).toThrow(/localhost/);
  });

  it('refuses a second API replica in production', () => {
    const scaled = { ...validProductionEnv, ORDER_WORKFLOW_MODE: 'single-instance' };
    expect(() => validateEnv(scaled)).toThrow();
  });

  it('requires the memory-only persistence mode to be off in production', () => {
    const memory = { ...validProductionEnv, PERSISTENCE_MODE: 'memory' };
    expect(() => validateEnv(memory)).toThrow();
  });

  it('enforces provider-specific email credentials', () => {
    const noResendKey = { ...validProductionEnv } as Record<string, unknown>;
    delete noResendKey.RESEND_API_KEY;
    expect(() => validateEnv(noResendKey)).toThrow(/RESEND_API_KEY/);
    const gmail = { ...validProductionEnv, EMAIL_PROVIDER: 'gmail' } as Record<string, unknown>;
    expect(() => validateEnv(gmail)).toThrow(/resend/);
  });

  it('keeps non-production boot ergonomic while still validating declared values', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: 'development', PERSISTENCE_MODE: 'prisma' })).toThrow(/DATABASE_URL/);
  });
});
