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
import type {
  PaymentContext,
  PaymentGateway,
  PaymentInitiation,
  PaymentVerification,
} from "../payment-gateway.js";

type Bank = {
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
  private get base() {
    return (process.env.FONEPAY_BASE_URL ?? "").replace(/\/+$/, "");
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
    const value = JSON.stringify(payload);
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
    const path = "/api/merchant/third-party/v2/login";
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
    const reference = `VC${input.attemptId.replace(/[^A-Za-z0-9]/g, "").slice(0, 28)}`;
    const banksRaw = await this.request(
      "/api/merchant/third-party/v2/banks/list",
      "GET",
      undefined,
      { paymentMode: "INTENT" },
      input.orderId,
    );
    const banks = bankListSchema.safeParse(banksRaw);
    if (!banks.success)
      return this.fail("Fonepay bank-list response was invalid");
    const qrRaw = await this.request(
      "/api/merchant/third-party/v2/generate-intent-qr",
      "POST",
      {
        amount: input.amountNpr,
        billId: input.orderNumber,
        terminalId: process.env.FONEPAY_TERMINAL_ID!,
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
      banks: banks.data.bankDetails as Bank[],
    };
  }
  async verify(
    reference: string,
    context: PaymentContext,
  ): Promise<PaymentVerification> {
    const raw = await this.request(
      "/api/merchant/third-party/v2/thirdPartyDynamicQrGetStatus",
      "POST",
      {
        terminalId: process.env.FONEPAY_TERMINAL_ID!,
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
    if (data.merchantCode !== process.env.FONEPAY_TERMINAL_ID)
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
