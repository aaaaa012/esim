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
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().optional(),
  DATABASE_URL: z.string().min(1).optional(),
  PERSISTENCE_MODE: z.enum(["prisma", "memory"]).optional(),
  REDIS_URL: z.string().min(1).optional(),
  APP_ENCRYPTION_KEY_BASE64: z.string().min(16).optional(),
  PAYMENT_MODE: z.enum(["sandbox", "simulator"]).optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
});

const productionSchema = baseSchema.extend({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY_BASE64: z.string().min(16),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  TRANSATEL_WEBHOOK_SECRET: z.string().min(16),
  TRANSATEL_API_KEY: z.string().min(1),
});

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
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
    throw new Error("REDIS_URL is set but empty. Refusing to boot with an unusable queue.");
  }
  return config;
}

function failWith(result: { error?: { issues?: Array<{ path: Array<PropertyKey>; message: string }> } }): never {
  const detail = result.error?.issues?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Environment configuration is invalid: ${detail ?? "unknown"}`);
}