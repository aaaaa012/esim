import { z } from "zod";
import { decodeAes256Key } from "./encryption-key.js";

/**
 * Fail-fast validation of the environment. Required production secrets must be
 * present (or the process refuses to boot) so a misconfigured deployment can
 * never silently run with forged-webhook or plaintext-encryption fallbacks.
 *
 * The default (non-production) schema deliberately keeps most values optional
 * so local/staging development stays ergonomic, while the production schema
 * hard-requires every secret that other code paths treat as mandatory.
 */
const baseSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "staging", "production"])
    .default("development"),
  API_PUBLIC_URL: z.string().url().optional(),
  CUSTOMER_WEB_URL: z.string().url().optional(),
  OPS_WEB_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  PERSISTENCE_MODE: z.enum(["prisma", "memory"]).optional(),
  REDIS_URL: z.string().min(1).optional(),
  APP_ENCRYPTION_KEY_BASE64: z.string().min(16).optional(),
  PAYMENT_MODE: z
    .enum(["khalti", "fonepay", "sandbox", "simulator"])
    .optional(),
  FONEPAY_ENABLED: z.enum(["true", "false"]).optional(),
  FONEPAY_BASE_URL: z.string().url().optional(),
  FONEPAY_USERNAME: z.string().min(1).optional(),
  FONEPAY_PASSWORD: z.string().min(1).optional(),
  FONEPAY_TERMINAL_ID: z.string().min(1).max(16).optional(),
  FONEPAY_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  FONEPAY_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  CONNECTIVITY_PROVIDER: z.enum(["transatel", "auriga-mock"]).optional(),
  GUEST_ORDER_SECRET: z.string().min(32).optional(),
  PII_HASH_KEY: z.string().min(32).optional(),
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_SUPER_ADMIN_TOKEN: z.string().min(32).optional(),
  OPS_ALERT_EMAIL: z.string().email().optional(),
  ADMIN_ALERT_EMAIL: z.string().email().optional(),
  NOTIFICATION_MODE: z.enum(["live", "simulator"]).optional(),
  EMAIL_PROVIDER: z.literal("ses").optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).optional(),
  EMAIL_REPLY_TO: z.string().email().optional(),
  KHALTI_SECRET_KEY: z.string().min(1).optional(),
  KHALTI_BASE_URL: z.string().url().optional(),
  KHALTI_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .optional(),
  FONEPAY_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .optional(),
  FONEPAY_BANK_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(604_800)
    .optional(),
  FONEPAY_BANK_MAX_STALE_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(2_592_000)
    .optional(),
  PASSPORT_OCR_MAX_PAGES: z.coerce.number().int().min(1).max(16).optional(),
  PASSPORT_OCR_MODE: z.enum(["local", "hybrid", "textract"]).optional(),
  PASSPORT_OCR_LOCAL_WAITING_LIMIT: z.coerce.number().int().min(1).optional(),
  PASSPORT_OCR_LOCAL_MAX_AGE_MS: z.coerce.number().int().positive().optional(),
  PASSPORT_OCR_HEARTBEAT_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  PASSPORT_OCR_TEXTRACT_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional(),
  PASSPORT_OCR_TEXTRACT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .optional(),
  PASSPORT_OCR_FALLBACK_ENABLED: z.enum(["true", "false"]).optional(),
  PARTNER_WEBHOOK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .optional(),
  TRANSATEL_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .optional(),
  TRANSATEL_CIRCUIT_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .min(2)
    .max(20)
    .optional(),
  TRANSATEL_CIRCUIT_RESET_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .optional(),
  TRANSATEL_REACTIVATION_APPROVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(1_440)
    .optional(),
  PARTNER_RATE_BUCKET_RETENTION_HOURS: z.coerce
    .number()
    .int()
    .min(2)
    .max(720)
    .optional(),
  DATA_RETENTION_ENABLED: z.enum(["true", "false"]).optional(),
  DATA_RETENTION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .optional(),
  INTEGRATION_LOG_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_650)
    .optional(),
  WEBHOOK_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_650)
    .optional(),
  NOTIFICATION_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_650)
    .optional(),
  AUDIT_LOG_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(365)
    .max(3_650)
    .optional(),
  TRANSATEL_BASE_URL: z.string().url().optional(),
  TRANSATEL_CLIENT_ID: z.string().min(1).optional(),
  TRANSATEL_CLIENT_SECRET: z.string().min(1).optional(),
  TRANSATEL_MVNO_REF: z.string().min(1).optional(),
  TRANSATEL_WEBHOOK_TARGET_URL: z.string().url().optional(),
  AWS_REGION: z.string().min(1).optional(),
  AWS_TEXTRACT_REGION: z.string().min(1).optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AWS_SESSION_TOKEN: z.string().min(1).optional(),
  AWS_S3_BUCKET: z.string().min(3).optional(),
  AWS_MARKETING_ASSET_BUCKET: z.string().min(3).optional(),
  PUBLIC_ASSET_BASE_URL: z.string().url().optional(),
  AWS_S3_ENDPOINT: z.string().url().optional(),
  AWS_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
  AWS_SES_REGION: z.string().min(1).optional(),
  AWS_SES_CONFIGURATION_SET: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  E2E_AUTH_ENABLED: z.enum(["true", "false"]).optional(),
  E2E_AUTH_SECRET: z.string().min(32).optional(),
  AUTH_ME_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(10)
    .max(10_000)
    .optional(),
  AUTH_ME_IP_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(10)
    .max(100_000)
    .optional(),
  ORDER_WORKFLOW_MODE: z.enum(["single-instance", "database-first"]).optional(),
  PAYMENT_VERIFY_ATTEMPTS: z.coerce.number().int().positive().optional(),
  INVENTORY_PROVIDER_FRESHNESS_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  INVENTORY_RESERVATION_STALE_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  REFUND_ATTENTION_HOURS: z.coerce.number().int().positive().optional(),
  OCR_FAILURE_GRACE_SECONDS: z.coerce.number().int().positive().optional(),
  OCR_TECHNICAL_RETRY_SECONDS: z.coerce.number().int().positive().optional(),
  OCR_RECOVERY_SWEEP_SECONDS: z.coerce.number().int().positive().optional(),
});

const productionSchema = baseSchema.extend({
  API_PUBLIC_URL: z
    .string()
    .url()
    .refine(
      (url) => !url.includes("localhost") && !url.includes("127.0.0.1"),
      "must not use localhost in production",
    ),
  CUSTOMER_WEB_URL: z
    .string()
    .url()
    .refine(
      (url) => !url.includes("localhost") && !url.includes("127.0.0.1"),
      "must not use localhost in production",
    ),
  OPS_WEB_URL: z
    .string()
    .url()
    .refine(
      (url) => !url.includes("localhost") && !url.includes("127.0.0.1"),
      "must not use localhost in production",
    ),
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1),
  PERSISTENCE_MODE: z.literal("prisma"),
  REDIS_URL: z.string().min(1),
  APP_ENCRYPTION_KEY_BASE64: z.string().min(16),
  PII_HASH_KEY: z.string().min(32),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(16),
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email(),
  BOOTSTRAP_SUPER_ADMIN_TOKEN: z.string().min(32),
  GUEST_ORDER_SECRET: z.string().min(32),
  OPS_ALERT_EMAIL: z.string().email(),
  ADMIN_ALERT_EMAIL: z.string().email(),
  PAYMENT_MODE: z.literal("khalti"),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  KHALTI_SECRET_KEY: z.string().min(1),
  CONNECTIVITY_PROVIDER: z.literal("transatel"),
  TRANSATEL_BASE_URL: z.string().url(),
  TRANSATEL_CLIENT_ID: z.string().min(1),
  TRANSATEL_CLIENT_SECRET: z.string().min(1),
  TRANSATEL_MVNO_REF: z.string().min(1),
  TRANSATEL_WEBHOOK_TARGET_URL: z.string().url(),
  TRANSATEL_WEBHOOK_SECRET: z.string().min(16),
  NOTIFICATION_MODE: z.literal("live"),
  EMAIL_PROVIDER: z.literal("ses"),
  EMAIL_FROM_ADDRESS: z.string().email(),
  EMAIL_FROM_NAME: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(3),
  TRUST_PROXY: z.string().min(1),
  // Production lifecycle commands use PostgreSQL compare-and-set transitions;
  // the in-process lock is only a development fallback.
  ORDER_WORKFLOW_MODE: z.literal("database-first"),
});

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.NODE_ENV === "production") {
    if (config.E2E_AUTH_ENABLED === "true" || config.E2E_AUTH_SECRET) {
      throw new Error("Local E2E authentication is forbidden in production");
    }
    const productionResult = productionSchema.safeParse(config);
    if (!productionResult.success) return failWith(productionResult);
    const ocrMode = config.PASSPORT_OCR_MODE ?? "hybrid";
    if (
      (ocrMode === "hybrid" || ocrMode === "textract") &&
      !config.AWS_TEXTRACT_REGION &&
      !config.AWS_REGION
    )
      throw new Error(
        "AWS_TEXTRACT_REGION or AWS_REGION is required for Textract OCR",
      );
    decodeAes256Key(config.APP_ENCRYPTION_KEY_BASE64);
    assertFonepayConfiguration(config);
    return config;
  }
  const result = baseSchema.safeParse(config);
  if (!result.success) return failWith(result);
  assertFonepayConfiguration(config);

  if (config.E2E_AUTH_ENABLED === "true") {
    if (config.NODE_ENV !== "test")
      throw new Error("E2E_AUTH_ENABLED=true requires NODE_ENV=test");
    if (
      typeof config.E2E_AUTH_SECRET !== "string" ||
      config.E2E_AUTH_SECRET.length < 32
    )
      throw new Error(
        "E2E_AUTH_ENABLED=true requires E2E_AUTH_SECRET of at least 32 characters",
      );
  }

  // Even outside production, if an encryption key or persistence is configured
  // it must be valid; never silently degrade to development-only fallbacks.
  if (config.PERSISTENCE_MODE === "prisma" && !config.DATABASE_URL) {
    throw new Error(
      "PERSISTENCE_MODE=prisma requires DATABASE_URL. Refusing to boot.",
    );
  }
  if (config.REDIS_URL && !(`${config.REDIS_URL}`.length > 1)) {
    throw new Error(
      "REDIS_URL is set but empty. Refusing to boot with an unusable queue.",
    );
  }
  return config;
}

function assertFonepayConfiguration(config: Record<string, unknown>) {
  if (config.FONEPAY_ENABLED !== "true") return;
  const required = [
    "FONEPAY_BASE_URL",
    "FONEPAY_USERNAME",
    "FONEPAY_PASSWORD",
    "FONEPAY_TERMINAL_ID",
  ].filter((key) => !config[key]);
  if (!config.FONEPAY_PRIVATE_KEY_PATH && !config.FONEPAY_PRIVATE_KEY_BASE64)
    required.push("FONEPAY_PRIVATE_KEY_PATH or FONEPAY_PRIVATE_KEY_BASE64");
  if (required.length)
    throw new Error(
      `FONEPAY_ENABLED=true requires ${required.join(", ")}. Refusing to boot.`,
    );
}

function failWith(result: {
  error?: { issues?: Array<{ path: Array<PropertyKey>; message: string }> };
}): never {
  const detail = result.error?.issues
    ?.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(
    `Environment configuration is invalid: ${detail ?? "unknown"}`,
  );
}
