import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import { z } from "zod";
import { ApiErrorCode, PaymentStatus } from "@visa-compass/shared";
import { ApiException } from "../../../common/api-error.js";
import { logRedactionEnabled } from "../../../common/redact.js";
import { PrismaService } from "../../../infrastructure/prisma.service.js";
import { resiliencePolicy } from "../../../infrastructure/resilience-policy.js";
import {
  PaymentCapability,
  PaymentInitiationError,
  initiationFailedBeforeRemoteIntent,
  initiationRemoteOutcomeUnknown,
} from "../payment-gateway.js";
import type {
  PaymentContext,
  PaymentGateway,
  PaymentInitiation,
  PaymentVerification,
} from "../payment-gateway.js";

/** V1.10 contract: referenceLabel max 30; live support confirms 25-char effective ceiling. */
const FONEPAY_REFERENCE_MAX = 25;
const FONEPAY_AMOUNT_MIN = 1;
const FONEPAY_AMOUNT_MAX = 9_999_999;
/** QR fields that carry payment payload data and must be redacted in logs. */
const REDACTED_QR_FIELDS = new Set(["qrstring", "qrmessage"]);
/** V1.10 §9.4 / §9.6: referenceLabel must be alphanumeric only. */
const REFERENCE_LABEL_RE = /^[A-Za-z0-9]+$/;
/** Deep-link scheme shapes accepted from Fonepay's bank directory: bare
 * ("scheme"), suffixed with authority ("scheme://"), or with the payment path
 * ("scheme://payment", optional trailing slash). Anything else is rejected and
 * the deep link is always rebuilt from the bare token. */
const FONEPAY_SCHEME_RE = /^([a-z][a-z0-9+.-]*)(?::\/\/(?:payment\/?)?)?$/i;
const FONEPAY_BLOCKED_SCHEMES = new Set([
  "data",
  "file",
  "http",
  "https",
  "javascript",
]);

/** Strips any "://[payment]" suffix to expose the bare issuer scheme. */
function bareScheme(raw: string): string | null {
  const scheme = raw.trim().match(FONEPAY_SCHEME_RE)?.[1];
  if (!scheme || FONEPAY_BLOCKED_SCHEMES.has(scheme.toLowerCase())) return null;
  return scheme;
}

export type FonepayBank = {
  bankName: string;
  bankCode: string;
  bankIcon?: string;
  packageName?: string;
  intentScheme: string;
};

const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.coerce.number().positive().default(600),
});
const bankSchema = z.object({
  bankName: z.string().min(1),
  bankCode: z.string().min(1),
  bankIcon: z.string().optional(),
  packageName: z.string().optional(),
  intentScheme: z.string().min(1),
});
const bankListSchema = z.object({
  bankDetails: z.array(bankSchema).default([]),
});
const qrResponseSchema = z
  .object({
    prn: z.string().min(1),
    qrMessage: z.string().min(1).optional(),
    qrString: z.string().min(1).optional(),
    qrDisplayName: z.string().optional(),
    paymentMessage: z.string().optional(),
    terminalId: z.coerce.number().optional(),
    websocketId: z.string().url().optional(),
    status: z.string().min(1),
  })
  .refine(
    (value) => value.qrMessage || value.qrString,
    "QR payload is missing",
  );
const statusResponseSchema = z.object({
  prn: z.string().min(1),
  merchantCode: z.string().min(1),
  paymentStatus: z.string().min(1),
  requestedAmount: z.coerce.number().finite().nonnegative(),
  totalTransactionAmount: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.coerce.number().finite().nonnegative().optional(),
  ),
  fonepayTraceId: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.union([z.string().min(1), z.number()]).optional(),
  ),
  paymentMessage: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional(),
  ),
});

/** Fonepay Checkout Intent/Dynamic-QR adapter. Credentials and payload signing never leave the API. */
@Injectable()
export class FonepayGateway implements PaymentGateway {
  readonly provider = "FONEPAY";
  private readonly logger = new Logger(FonepayGateway.name);
  private token?: { value: string; expiresAt: number };
  private pendingAuth: Promise<string> | undefined;
  constructor(@Optional() private readonly prisma?: PrismaService) {}

  capabilities() {
    return {
      checkout: "QR" as const,
      statusLookup: true,
      refunds: "MANUAL" as const,
      disputes: "NOT_SUPPORTED" as const,
      extra: [
        PaymentCapability.BANK_DIRECTORY,
        PaymentCapability.PROVIDER_WEBSOCKET,
        PaymentCapability.MANUAL_REFUND_GUIDANCE,
      ],
    };
  }
  private get base() {
    return (process.env.FONEPAY_BASE_URL ?? "").replace(/\/+$/, "");
  }
  private get basePath() {
    return (
      process.env.FONEPAY_API_BASE_PATH ?? "/api/merchant/third-party/v2"
    ).replace(/\/+$/, "");
  }
  private configured() {
    return (
      process.env.FONEPAY_ENABLED === "true" &&
      this.base &&
      process.env.FONEPAY_USERNAME &&
      process.env.FONEPAY_PASSWORD &&
      process.env.FONEPAY_TERMINAL_ID &&
      (process.env.FONEPAY_PRIVATE_KEY_PATH ||
        process.env.FONEPAY_PRIVATE_KEY_BASE64)
    );
  }
  private fail(details: string): never {
    throw new ApiException({
      code: ApiErrorCode.PAYMENT_PROVIDER_ERROR,
      message:
        "Fonepay is temporarily unavailable. Please choose Khalti or try again shortly.",
      status: 503,
      details,
    });
  }
  private failBeforeIntent(details: string): never {
    try {
      return this.fail(details);
    } catch (error) {
      throw initiationFailedBeforeRemoteIntent(error);
    }
  }
  private terminalId(): string {
    const terminalId = process.env.FONEPAY_TERMINAL_ID;
    if (!terminalId || terminalId.length > 16)
      return this.fail(
        "Fonepay terminalId is missing or exceeds 16 characters (V1.10 contract)",
      );
    return terminalId;
  }
  private redact(value: unknown): Prisma.InputJsonValue {
    if (!logRedactionEnabled()) return value as Prisma.InputJsonValue;
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => {
          const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
          if (
            (normalizedKey === "qrstring" || normalizedKey === "qrmessage") &&
            typeof item === "string"
          ) {
            const fingerprint = createHash("sha256")
              .update(item)
              .digest("hex")
              .slice(0, 16);
            return [
              key,
              `[REDACTED length=${item.length} sha256=${fingerprint}]`,
            ];
          }
          if (/websocket/i.test(key) && typeof item === "string") {
            try {
              const url = new URL(item);
              return [
                key,
                `[REDACTED protocol=${url.protocol.replace(":", "")} host=${url.host}]`,
              ];
            } catch {
              return [key, "[REDACTED invalid-url]"];
            }
          }
          const isSecret =
            /authorization|password|secret|signature|token/i.test(key) ||
            REDACTED_QR_FIELDS.has(normalizedKey) ||
            /websocket/i.test(key);
          return [key, isSecret ? "[REDACTED]" : this.redact(item)];
        }),
      );
    if (["string", "number", "boolean"].includes(typeof value))
      return value as string | number | boolean;
    return "";
  }
  private async record(entry: {
    operation: string;
    method: string;
    endpoint: string;
    status: number;
    durationMs: number;
    correlationId?: string;
    errorCode?: string;
    errorMessage?: string;
    requestHeaders?: Prisma.InputJsonValue;
    requestBody?: Prisma.InputJsonValue;
    responseBody?: Prisma.InputJsonValue;
  }) {
    if (!this.prisma?.enabled) return;
    try {
      await this.prisma.integrationLog.create({ data: entry });
    } catch (error) {
      this.logger.error(
        `Failed to persist integration log for ${entry.operation}`,
        error,
      );
    }
  }
  private sign(payload: unknown) {
    return this.signString(JSON.stringify(payload));
  }
  private signString(value: string) {
    try {
      const configured = process.env.FONEPAY_PRIVATE_KEY_PATH
        ? readFileSync(process.env.FONEPAY_PRIVATE_KEY_PATH, "utf8")
        : process.env.FONEPAY_PRIVATE_KEY_BASE64!;
      const raw = configured.replace(/\\n/g, "\n").trim();
      let key: ReturnType<typeof createPrivateKey>;
      if (raw.includes("-----BEGIN PRIVATE KEY-----")) {
        key = createPrivateKey(raw);
      } else {
        const encoded = raw.replace(/\s+/g, "");
        const bytes =
          /^[0-9a-f]+$/i.test(encoded) && encoded.length % 2 === 0
            ? Buffer.from(encoded, "hex")
            : Buffer.from(encoded, "base64");
        const decoded = bytes.toString("utf8").trim();
        key = decoded.includes("-----BEGIN PRIVATE KEY-----")
          ? createPrivateKey(decoded)
          : createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
      }
      const signer = createSign("RSA-SHA256");
      signer.update(value);
      signer.end();
      return signer.sign(key, "base64");
    } catch {
      return this.fail("Fonepay private key is invalid or unreadable");
    }
  }
  private async auth(correlationId?: string) {
    if (!this.configured())
      return this.fail("Fonepay is not enabled or fully configured");
    if (this.token && this.token.expiresAt > Date.now() + 30_000)
      return this.token.value;
    // Single-flight: concurrent callers share one in-flight authentication so
    // an expired token cannot trigger a stampede of duplicate OAuth requests
    // that race to overwrite the cached token.
    if (this.pendingAuth) return this.pendingAuth;
    this.pendingAuth = this.obtainToken(correlationId).finally(() => {
      this.pendingAuth = undefined;
    });
    return this.pendingAuth;
  }
  private async obtainToken(correlationId?: string) {
    const body = {
      username: process.env.FONEPAY_USERNAME!,
      password: process.env.FONEPAY_PASSWORD!,
    };
    const path =
      process.env.FONEPAY_LOGIN_PATH?.trim() || `${this.basePath}/login`;
    const signature = this.sign(body);
    const credentialLog = logRedactionEnabled()
      ? { username: "[REDACTED]", password: "[REDACTED]" }
      : { username: body.username, password: body.password };
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${body.username}:${body.password}`).toString("base64")}`,
          signature,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(resiliencePolicy.fonepayTimeoutMs()),
      });
    } catch (error) {
      await this.record({
        operation: "fonepay-authentication",
        method: "POST",
        endpoint: path,
        status: 0,
        durationMs: Date.now() - startedAt,
        ...(correlationId ? { correlationId } : {}),
        errorCode: "NETWORK_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
        requestBody: credentialLog,
      });
      return this.fail("Fonepay OAuth network request failed");
    }
    const raw = await response.json().catch(() => ({}));
    await this.record({
      operation: "fonepay-authentication",
      method: "POST",
      endpoint: path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...(correlationId ? { correlationId } : {}),
      ...(!response.ok
        ? {
            errorCode: `HTTP_${response.status}`,
            errorMessage: "Fonepay authentication was rejected",
          }
        : {}),
      requestBody: credentialLog,
      responseBody: this.redact(raw),
    });
    if (!response.ok) return this.fail("Fonepay OAuth authentication failed");
    const parsed = authResponseSchema.safeParse(raw);
    if (!parsed.success) return this.fail("Fonepay OAuth response was invalid");
    const data = parsed.data;
    this.token = {
      value: data.accessToken.replace(/^Bearer\s+/i, ""),
      expiresAt: Date.now() + data.expiresIn * 1_000,
    };
    return this.token.value;
  }
  private async request(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    extra: Record<string, string> = {},
    correlationId?: string,
  ) {
    let token = await this.auth(correlationId);
    const payload = body ?? {};
    let startedAt = Date.now();
    // Ops need the exact request shape (notably paymentMode) to reproduce an
    // issuer's rejection. Log the safe headers only: never the bearer token
    // and never the request signature.
    const requestHeaders: Record<string, string> =
      method === "POST" ? { "content-type": "application/json" } : {};
    for (const [key, value] of Object.entries(extra))
      if (key.toLowerCase() !== "signature") requestHeaders[key] = value;
    const execute = (accessToken: string) =>
      fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(method === "POST"
            ? {
                "Content-Type": "application/json",
                signature: this.sign(payload),
              }
            : {}),
          ...extra,
        },
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(resiliencePolicy.fonepayTimeoutMs()),
      });
    let response: Response;
    try {
      response = await execute(token);
    } catch (error) {
      await this.record({
        operation: `fonepay-${path.split("/").filter(Boolean).at(-1) ?? "request"}`,
        method,
        endpoint: path,
        status: 0,
        durationMs: Date.now() - startedAt,
        ...(correlationId ? { correlationId } : {}),
        errorCode: "NETWORK_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
        requestHeaders,
        requestBody: this.redact(payload),
      });
      return this.fail(`Fonepay ${path} network request failed`);
    }
    let data = await response.json().catch(() => ({}));
    await this.record({
      operation: `fonepay-${path.split("/").filter(Boolean).at(-1) ?? "request"}`,
      method,
      endpoint: path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...(correlationId ? { correlationId } : {}),
      ...(!response.ok
        ? {
            errorCode: `HTTP_${response.status}`,
            errorMessage: `Fonepay returned HTTP ${response.status}`,
          }
        : {}),
      requestHeaders,
      requestBody: this.redact(payload),
      responseBody: this.redact(data),
    });
    if (response.status === 401) {
      // The provider may revoke a token before its advertised expiresIn. Only
      // clear the token used by this request so a concurrent successful refresh
      // is not discarded, then authenticate and replay exactly once.
      if (this.token?.value === token) delete this.token;
      token = await this.auth(correlationId);
      startedAt = Date.now();
      try {
        response = await execute(token);
      } catch (error) {
        await this.record({
          operation: `fonepay-${path.split("/").filter(Boolean).at(-1) ?? "request"}-auth-retry`,
          method,
          endpoint: path,
          status: 0,
          durationMs: Date.now() - startedAt,
          ...(correlationId ? { correlationId } : {}),
          errorCode: "NETWORK_ERROR",
          errorMessage: error instanceof Error ? error.message : String(error),
          requestHeaders,
          requestBody: this.redact(payload),
        });
        return this.fail(`Fonepay ${path} authentication retry failed`);
      }
      data = await response.json().catch(() => ({}));
      await this.record({
        operation: `fonepay-${path.split("/").filter(Boolean).at(-1) ?? "request"}-auth-retry`,
        method,
        endpoint: path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...(correlationId ? { correlationId } : {}),
        ...(!response.ok
          ? {
              errorCode: `HTTP_${response.status}`,
              errorMessage: `Fonepay authentication retry returned HTTP ${response.status}`,
            }
          : {}),
        requestHeaders,
        requestBody: this.redact(payload),
        responseBody: this.redact(data),
      });
    }
    if (!response.ok) {
      try {
        return this.fail(`Fonepay ${path} failed (${response.status})`);
      } catch (error) {
        if (path.endsWith("/generate-intent-qr"))
          throw initiationFailedBeforeRemoteIntent(error);
        throw error;
      }
    }
    return data as Record<string, unknown>;
  }

  private validBank(bank: z.infer<typeof bankSchema>): FonepayBank | null {
    const intentScheme = bareScheme(bank.intentScheme);
    if (!intentScheme) return null;
    const bankIcon = bank.bankIcon?.trim();
    if (bankIcon) {
      try {
        if (new URL(bankIcon).protocol !== "https:") return null;
      } catch {
        return null;
      }
    }
    return {
      bankName: bank.bankName.trim(),
      bankCode: bank.bankCode.trim(),
      ...(bankIcon ? { bankIcon } : {}),
      ...(bank.packageName?.trim()
        ? { packageName: bank.packageName.trim() }
        : {}),
      intentScheme,
    };
  }

  private safeWebsocketUrl(value?: string): string | undefined {
    if (!value) return undefined;
    const protocol = new URL(value).protocol;
    if (protocol === "wss:") return value;
    if (protocol === "ws:" && process.env.NODE_ENV !== "production")
      return value;
    this.logger.warn("Ignored an insecure Fonepay WebSocket URL");
    return undefined;
  }

  private async fetchBanks(correlationId?: string): Promise<FonepayBank[]> {
    const raw = await this.request(
      `${this.basePath}/banks/list`,
      "GET",
      undefined,
      {
        paymentMode: "INTENT",
        signature: this.signString(""),
      },
      correlationId,
    );
    const parsed = bankListSchema.safeParse(raw);
    if (!parsed.success)
      return this.fail("Fonepay bank-list response was invalid");
    const banks = parsed.data.bankDetails
      .map((bank) => this.validBank(bank))
      .filter((bank): bank is FonepayBank => Boolean(bank));
    if (banks.length !== parsed.data.bankDetails.length)
      this.logger.warn(
        "Ignored one or more unsafe Fonepay bank directory entries",
      );
    return banks;
  }

  async bankDirectory() {
    if (!this.prisma?.enabled) return { banks: [], lastSyncedAt: null };
    const [banks, latest] = await Promise.all([
      this.prisma.fonepayBankDirectoryEntry.findMany({
        where: { active: true },
        orderBy: { bankName: "asc" },
      }),
      this.prisma.fonepayBankDirectorySync.findFirst({
        where: { status: "SUCCEEDED" },
        orderBy: { completedAt: "desc" },
      }),
    ]);
    return { banks, lastSyncedAt: latest?.completedAt?.toISOString() ?? null };
  }

  async syncBankDirectory(requestedById?: string) {
    if (!this.prisma?.enabled)
      return { banks: await this.fetchBanks(), lastSyncedAt: null };
    const sync = await this.prisma.fonepayBankDirectorySync.create({
      data: { status: "RUNNING", ...(requestedById ? { requestedById } : {}) },
    });
    try {
      const banks = await this.fetchBanks(sync.id);
      const now = new Date();
      const existing = await this.prisma.fonepayBankDirectoryEntry.findMany();
      const byCode = new Map(existing.map((bank) => [bank.bankCode, bank]));
      const incomingCodes = banks.map((bank) => bank.bankCode);
      let addedCount = 0;
      let updatedCount = 0;
      for (const bank of banks) {
        if (byCode.has(bank.bankCode)) updatedCount += 1;
        else addedCount += 1;
        await this.prisma.fonepayBankDirectoryEntry.upsert({
          where: { bankCode: bank.bankCode },
          create: { ...bank, active: true, firstSeenAt: now, lastSeenAt: now },
          update: { ...bank, active: true, lastSeenAt: now },
        });
      }
      const deactivated =
        await this.prisma.fonepayBankDirectoryEntry.updateMany({
          where: incomingCodes.length
            ? { active: true, bankCode: { notIn: incomingCodes } }
            : { active: true },
          data: { active: false },
        });
      await this.prisma.fonepayBankDirectorySync.update({
        where: { id: sync.id },
        data: {
          status: "SUCCEEDED",
          totalCount: banks.length,
          addedCount,
          updatedCount,
          deactivatedCount: deactivated.count,
          completedAt: now,
        },
      });
      return this.bankDirectory();
    } catch (error) {
      await this.prisma.fonepayBankDirectorySync.update({
        where: { id: sync.id },
        data: {
          status: "FAILED",
          errorMessage: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async banksForCheckout(
    correlationId: string,
  ): Promise<FonepayBank[]> {
    const cached = await this.bankDirectory();
    const toBank = (bank: {
      bankName: string;
      bankCode: string;
      intentScheme: string;
      bankIcon?: string | null;
      packageName?: string | null;
    }): FonepayBank | null => {
      const intentScheme = bareScheme(bank.intentScheme);
      if (!intentScheme) return null;
      return {
        bankName: bank.bankName,
        bankCode: bank.bankCode,
        intentScheme,
        ...(bank.bankIcon ? { bankIcon: bank.bankIcon } : {}),
        ...(bank.packageName ? { packageName: bank.packageName } : {}),
      };
    };
    const ttlMs =
      Math.max(
        300,
        Number(process.env.FONEPAY_BANK_CACHE_TTL_SECONDS ?? 3_600),
      ) * 1_000;
    const cachedBanks = cached.banks
      .map(toBank)
      .filter((bank): bank is FonepayBank => Boolean(bank));
    const cacheAgeMs = cached.lastSyncedAt
      ? Date.now() - new Date(cached.lastSyncedAt).getTime()
      : Number.POSITIVE_INFINITY;
    const maximumStaleMs =
      Math.max(
        300,
        Number(process.env.FONEPAY_BANK_MAX_STALE_SECONDS ?? 604_800),
      ) * 1_000;
    // Issuer deep-link schemes change, so a checkout must reflect the directory
    // as it is right now. Fetch /banks/list live on every initiation (matching
    // the reference SDK, which never caches it); the synced table is only a
    // circuit-breaker fallback: a fresh-enough cache is used silently, an
    // older-but-allowed one with a warning, and beyond that the QR scan path
    // still works with no bank list.
    try {
      return await this.fetchBanks(correlationId);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      if (cachedBanks.length && cacheAgeMs <= ttlMs) return cachedBanks;
      if (cachedBanks.length && cacheAgeMs <= maximumStaleMs) {
        this.logger.warn(
          `Fonepay bank directory unavailable; using cached copy: ${detail}`,
        );
        return cachedBanks;
      }
      this.logger.warn(
        `Fonepay bank directory unavailable; QR checkout remains available (${correlationId})`,
      );
      return [];
    }
  }

  /**
   * Restore issuer choices for an already-created intent. This never creates
   * another QR or payment reference; it only refreshes the provider directory
   * used to construct mobile deep links for the existing qrPayload.
   */
  async checkoutBanks(correlationId: string): Promise<FonepayBank[]> {
    return this.banksForCheckout(correlationId);
  }

  async initiate(input: {
    attemptId: string;
    orderId: string;
    orderNumber: string;
    amountNpr: number;
    returnUrl: string;
  }): Promise<PaymentInitiation> {
    if (
      !Number.isFinite(input.amountNpr) ||
      input.amountNpr < FONEPAY_AMOUNT_MIN ||
      input.amountNpr > FONEPAY_AMOUNT_MAX
    )
      return this.failBeforeIntent(
        `Fonepay amount must be between NPR ${FONEPAY_AMOUNT_MIN} and NPR ${FONEPAY_AMOUNT_MAX.toLocaleString()}`,
      );
    if (!input.orderNumber.trim())
      return this.failBeforeIntent("Fonepay billId must not be blank");
    // Fonepay requested a shorter billId. The QR/status flows only correlate
    // via referenceLabel/prn, so billId is a pure invoice label: derive a
    // compact alphanumeric value (VC + year-tail + order-id tail) from the
    // full order number (e.g. "VC-2026-520DD926" -> "VC26520DD926").
    const billMatch = input.orderNumber.match(/^VC-(\d{4})-([A-Za-z0-9]+)$/i);
    const billId = billMatch
      ? `VC${billMatch[1]!.slice(-2)}${billMatch[2]!.toUpperCase()}`
      : (input.orderNumber.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase() ||
          input.orderNumber);
    let terminalId: string;
    try {
      terminalId = this.terminalId();
    } catch (error) {
      throw initiationFailedBeforeRemoteIntent(error);
    }
    const alnumOnly = input.attemptId.replace(/[^A-Za-z0-9]/g, "");
    if (!alnumOnly)
      return this.failBeforeIntent(
        "Fonepay referenceLabel: attemptId produced no alphanumeric characters",
      );
    const reference = `VC${alnumOnly.slice(0, FONEPAY_REFERENCE_MAX - 2)}`;
    if (!REFERENCE_LABEL_RE.test(reference))
      return this.failBeforeIntent(
        "Fonepay referenceLabel must be alphanumeric only (V1.10 §9.4)",
      );
    try {
      // Authentication and signing complete before the payment-creating call.
      // A failure here proves that no remote intent exists.
      await this.auth(input.orderId);
    } catch (error) {
      throw initiationFailedBeforeRemoteIntent(error);
    }
    // Bank discovery is optional checkout enhancement data. A failed refresh
    // returns cached data (or an empty list) and must never block QR creation.
    const banks = await this.banksForCheckout(input.orderId);
    let qrRaw: Record<string, unknown>;
    try {
      qrRaw = await this.request(
        `${this.basePath}/generate-intent-qr`,
        "POST",
        {
          amount: input.amountNpr,
          billId,
          terminalId,
          paymentMode: "QR",
          referenceLabel: reference,
          qrType: "INTENT_QR",
        },
        {},
        input.orderId,
      );
    } catch (error) {
      if (error instanceof PaymentInitiationError) throw error;
      // Once the intent request has been sent, a lost/invalid response cannot
      // prove that Fonepay did not create the QR.
      throw initiationRemoteOutcomeUnknown(error);
    }
    const parsedQr = qrResponseSchema.safeParse(qrRaw);
    if (!parsedQr.success)
      throw initiationRemoteOutcomeUnknown(
        new Error("Fonepay QR response was invalid"),
      );
    const qr = parsedQr.data;
    if (qr.status.toLowerCase() !== "success")
      return this.failBeforeIntent(
        `Fonepay QR generation returned status: ${qr.status}`,
      );
    if (qr.prn !== reference)
      throw initiationRemoteOutcomeUnknown(
        new Error("Fonepay QR reference did not match the request"),
      );
    // V1.10 assigns distinct semantics: qrString is rendered for scanning,
    // while qrMessage is passed to an issuer app through its deep link.
    const qrPayload = qr.qrMessage?.trim();
    const qrScanPayload = (qr.qrString ?? qr.qrMessage!).trim();
    const websocketUrl = this.safeWebsocketUrl(qr.websocketId);
    return {
      reference,
      redirectUrl: "",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      correlationId: reference,
      ...(qrPayload ? { qrPayload } : {}),
      qrDataUrl: await QRCode.toDataURL(qrScanPayload, {
        margin: 4,
        width: 480,
        errorCorrectionLevel: "M",
      }),
      ...(websocketUrl ? { websocketUrl } : {}),
      banks,
    };
  }
  async verify(
    reference: string,
    context: PaymentContext,
  ): Promise<PaymentVerification> {
    if (!REFERENCE_LABEL_RE.test(reference))
      return this.fail(
        "Fonepay referenceLabel must be alphanumeric only (V1.10 §9.6)",
      );
    const terminalId = this.terminalId();
    const raw = await this.request(
      `${this.basePath}/thirdPartyDynamicQrGetStatus`,
      "POST",
      {
        terminalId,
        referenceLabel: reference,
      },
      {},
      context.correlationId ?? context.orderId,
    );
    const parsed = statusResponseSchema.safeParse(raw);
    if (!parsed.success)
      return this.fail("Fonepay payment-status response was invalid");
    const data = parsed.data;
    if (data.prn !== reference)
      return this.fail("Fonepay payment reference did not match the request");
    if (data.merchantCode !== terminalId)
      return this.fail("Fonepay merchant terminal did not match the request");
    const status = String(data.paymentStatus ?? "").toLowerCase();
    if (
      !["success", "pending", "failed", "cancelled", "timeout"].includes(status)
    )
      return this.fail(`Fonepay returned an unknown payment status: ${status}`);
    if (status === "success") {
      if (!data.fonepayTraceId)
        return this.fail(
          "Fonepay success response missing fonepayTraceId (required for reconciliation)",
        );
      if (Math.abs(data.requestedAmount - context.amountNpr) > 0.005)
        return this.fail(
          `Fonepay requestedAmount ${data.requestedAmount} does not match expected ${context.amountNpr}`,
        );
      if (
        data.totalTransactionAmount !== undefined &&
        Math.abs(data.totalTransactionAmount - data.requestedAmount) > 0.005
      )
        return this.fail(
          `Fonepay totalTransactionAmount ${data.totalTransactionAmount} differs from requestedAmount ${data.requestedAmount}`,
        );
    }
    // Fonepay returns HTTP 200 with paymentStatus=timeout and "Data not found"
    // when no matching transaction exists yet. That is not evidence of a
    // failed payment while the issued QR is still valid. Once our authoritative
    // payment window has elapsed, the same result can close the attempt.
    const timedOut = status === "timeout";
    const paymentWindowExpired =
      Boolean(context.expiresAt) &&
      new Date(context.expiresAt!).getTime() <= Date.now();
    return {
      reference,
      orderId: context.orderId,
      amountNpr: data.requestedAmount,
      currency: "NPR",
      ...(data.fonepayTraceId
        ? { providerTransactionId: String(data.fonepayTraceId) }
        : {}),
      status:
        status === "success"
          ? PaymentStatus.COMPLETED
          : status === "pending" || (timedOut && !paymentWindowExpired)
            ? PaymentStatus.PENDING
            : status === "cancelled"
              ? PaymentStatus.CANCELLED
              : PaymentStatus.FAILED,
    };
  }
}
