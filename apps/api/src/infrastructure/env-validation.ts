import { z } from "zod";

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
  PAYMENT_MODE: z.enum(["khalti", "sandbox", "simulator"]).optional(),
  CONNECTIVITY_PROVIDER: z.enum(["transatel", "auriga-mock"]).optional(),
  GUEST_ORDER_SECRET: z.string().min(32).optional(),
  PII_HASH_KEY: z.string().min(32).optional(),
  BOOTSTRAP_SUPER_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_SUPER_ADMIN_TOKEN: z.string().min(32).optional(),
  OPS_ALERT_EMAIL: z.string().email().optional(),
  ADMIN_ALERT_EMAIL: z.string().email().optional(),
  NOTIFICATION_MODE: z.enum(["live", "simulator"]).optional(),
  EMAIL_PROVIDER: z.literal("resend").optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).optional(),
  EMAIL_REPLY_TO: z.string().email().optional(),
  KHALTI_SECRET_KEY: z.string().min(1).optional(),
  TRANSATEL_BASE_URL: z.string().url().optional(),
  TRANSATEL_CLIENT_ID: z.string().min(1).optional(),
  TRANSATEL_CLIENT_SECRET: z.string().min(1).optional(),
  TRANSATEL_MVNO_REF: z.string().min(1).optional(),
  TRANSATEL_WEBHOOK_TARGET_URL: z.string().url().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
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
  EMAIL_PROVIDER: z.literal("resend"),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM_ADDRESS: z.string().email(),
  EMAIL_FROM_NAME: z.string().min(1),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  TRUST_PROXY: z.string().min(1),
  // Production lifecycle commands use PostgreSQL compare-and-set transitions;
  // the in-process lock is only a development fallback.
  ORDER_WORKFLOW_MODE: z.literal("database-first"),
});

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.NODE_ENV === "production") {
    return productionSchema.safeParse(config).success
      ? config
      : failWith(productionSchema.safeParse(config));
  }
  const result = baseSchema.safeParse(config);
  if (!result.success) return failWith(result);

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
