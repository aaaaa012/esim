import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import { z } from "zod";
import { ApiErrorCode, PaymentStatus } from "@visa-compass/shared";
import { ApiException } from "../../../common/api-error.js";
import { PrismaService } from "../../../infrastructure/prisma.service.js";
import { resiliencePolicy } from "../../../infrastructure/resilience-policy.js";
import { PaymentCapability } from "../payment-gateway.js";
import type {
  PaymentContext,
  PaymentGateway,
  PaymentInitiation,
  PaymentVerification,
} from "../payment-gateway.js";

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
  fonepayTraceId: z.union([z.string(), z.number()]).optional(),
});

/** Fonepay Checkout Intent/Dynamic-QR adapter. Credentials and payload signing never leave the API. */
@Injectable()
export class FonepayGateway implements PaymentGateway {
  readonly provider = "FONEPAY";
  private readonly logger = new Logger(FonepayGateway.name);
  private token?: { value: string; expiresAt: number };
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
  private terminalId(): string {
    const terminalId = process.env.FONEPAY_TERMINAL_ID;
    if (!terminalId || terminalId.length > 16)
      return this.fail(
        "Fonepay terminalId is missing or exceeds 16 characters (V1.10 contract)",
      );
    return terminalId;
  }
  private redact(value: unknown): Prisma.InputJsonValue {
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          /authorization|password|secret|signature|token|qr|string|websocket/i.test(
            key,
          )
            ? "[REDACTED]"
            : this.redact(item),
        ]),
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
        const bytes = /^[0-9a-f]+$/i.test(encoded) && encoded.length % 2 === 0
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
    const body = {
      username: process.env.FONEPAY_USERNAME!,
      password: process.env.FONEPAY_PASSWORD!,
    };
    const path = `${this.basePath}/login`;
    const signature = this.sign(body);
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
        requestBody: { username: "[REDACTED]", password: "[REDACTED]" },
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
      requestBody: { username: "[REDACTED]", password: "[REDACTED]" },
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
    const token = await this.auth(correlationId);
    const payload = body ?? {};
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
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
        requestBody: this.redact(payload),
      });
      return this.fail(`Fonepay ${path} network request failed`);
    }
    const data = await response.json().catch(() => ({}));
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
      requestBody: this.redact(payload),
      responseBody: this.redact(data),
    });
    if (!response.ok)
      return this.fail(`Fonepay ${path} failed (${response.status})`);
    return data as Record<string, unknown>;
  }

  private validBank(bank: z.infer<typeof bankSchema>): FonepayBank | null {
    const intentScheme = bank.intentScheme.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(intentScheme)) return null;
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
    if (!parsed.success) return this.fail("Fonepay bank-list response was invalid");
    const banks = parsed.data.bankDetails
      .map((bank) => this.validBank(bank))
      .filter((bank): bank is FonepayBank => Boolean(bank));
    if (banks.length !== parsed.data.bankDetails.length)
      this.logger.warn("Ignored one or more unsafe Fonepay bank directory entries");
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
      const deactivated = await this.prisma.fonepayBankDirectoryEntry.updateMany({
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
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

private async banksForCheckout(correlationId: string): Promise<FonepayBank[]> {
    const cached = await this.bankDirectory();
    const toBank = (bank: {
      bankName: string;
      bankCode: string;
      intentScheme: string;
      bankIcon?: string | null;
      packageName?: string | null;
    }): FonepayBank => ({
      bankName: bank.bankName,
      bankCode: bank.bankCode,
      intentScheme: bank.intentScheme,
      ...(bank.bankIcon ? { bankIcon: bank.bankIcon } : {}),
      ...(bank.packageName ? { packageName: bank.packageName } : {}),
    });
    const ttlMs = Math.max(300, Number(process.env.FONEPAY_BANK_CACHE_TTL_SECONDS ?? 86_400)) * 1_000;
    const fresh = cached.lastSyncedAt && Date.now() - new Date(cached.lastSyncedAt).getTime() < ttlMs;
    const cachedBanks = cached.banks.map(toBank);
    if (fresh && cachedBanks.length) return cachedBanks;
    try {
      const synced = await this.syncBankDirectory();
      return synced.banks.map(toBank);
    } catch (error) {
      if (cachedBanks.length) {
        this.logger.warn(`Using last-known-good Fonepay bank directory: ${error instanceof Error ? error.message : String(error)}`);
        return cachedBanks;
      }
      this.logger.warn(`Fonepay bank directory unavailable; QR checkout remains available (${correlationId})`);
      return [];
    }
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
      input.amountNpr < 1 ||
      input.amountNpr > 9_999_999
    )
      return this.fail(
        "Fonepay amount must be between NPR 1 and NPR 9,999,999",
      );
if (!input.orderNumber.trim())
      return this.fail("Fonepay billId must not be blank");
    const terminalId = this.terminalId();
    const reference = `VC${input.attemptId.replace(/[^A-Za-z0-9]/g, "").slice(0, 28)}`;
    // Bank discovery is optional checkout enhancement data. A failed refresh
    // returns cached data (or an empty list) and must never block QR creation.
    const banks = await this.banksForCheckout(input.orderId);
    const qrRaw = await this.request(
      `${this.basePath}/generate-intent-qr`,
      "POST",
      {
        amount: input.amountNpr,
        billId: input.orderNumber,
        terminalId,
        paymentMode: "QR",
        referenceLabel: reference,
        qrType: "INTENT_QR",
      },
      {},
      input.orderId,
    );
    const parsedQr = qrResponseSchema.safeParse(qrRaw);
    if (!parsedQr.success) return this.fail("Fonepay QR response was invalid");
    const qr = parsedQr.data;
    if (qr.status.toLowerCase() !== "success")
      return this.fail(`Fonepay QR generation returned status: ${qr.status}`);
    if (qr.prn !== reference)
      return this.fail("Fonepay QR reference did not match the request");
    const qrPayload = qr.qrMessage ?? qr.qrString!;
    return {
      reference,
      redirectUrl: "",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      correlationId: reference,
      qrPayload,
      qrDataUrl: await QRCode.toDataURL(qrPayload, { margin: 1, width: 360 }),
      ...(qr.websocketId ? { websocketUrl: qr.websocketId } : {}),
      banks,
    };
  }
  async verify(
    reference: string,
    context: PaymentContext,
  ): Promise<PaymentVerification> {
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
