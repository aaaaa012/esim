import { Injectable, Logger, Optional } from "@nestjs/common";
import { createPrivateKey, createSign } from "node:crypto";
import QRCode from "qrcode";
import { ApiErrorCode, PaymentStatus } from "@visa-compass/shared";
import { ApiException } from "../../../common/api-error.js";
import { PrismaService } from "../../../infrastructure/prisma.service.js";
import type { PaymentContext, PaymentGateway, PaymentInitiation, PaymentVerification } from "../payment-gateway.js";

type Bank = { bankName: string; bankCode: string; bankIcon?: string; packageName?: string; intentScheme: string };

/** Fonepay Checkout Intent/Dynamic-QR adapter. Credentials and payload signing never leave the API. */
@Injectable()
export class FonepayGateway implements PaymentGateway {
  readonly provider = "FONEPAY";
  private readonly logger = new Logger(FonepayGateway.name);
  private token?: { value: string; expiresAt: number };
  constructor(@Optional() private readonly prisma?: PrismaService) {}
  private get base() { return (process.env.FONEPAY_BASE_URL ?? "").replace(/\/+$/, ""); }
  private configured() {
    return process.env.FONEPAY_ENABLED === "true" && this.base && process.env.FONEPAY_USERNAME && process.env.FONEPAY_PASSWORD && process.env.FONEPAY_TERMINAL_ID && process.env.FONEPAY_PRIVATE_KEY_BASE64;
  }
  private fail(details: string): never { throw new ApiException({ code: ApiErrorCode.PAYMENT_PROVIDER_ERROR, message: "Fonepay is temporarily unavailable. Please choose Khalti or try again shortly.", status: 503, details }); }
  private sign(payload: unknown) {
    const value = JSON.stringify(payload);
    try {
      const raw = process.env.FONEPAY_PRIVATE_KEY_BASE64!;
      const key = raw.includes("BEGIN") ? raw : createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
      const signer = createSign("RSA-SHA256"); signer.update(value); signer.end(); return signer.sign(key, "base64");
    } catch { return this.fail("FONEPAY_PRIVATE_KEY_BASE64 is invalid"); }
  }
  private async auth() {
    if (!this.configured()) return this.fail("Fonepay is not enabled or fully configured");
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const body = { username: process.env.FONEPAY_USERNAME!, password: process.env.FONEPAY_PASSWORD! };
    const response = await fetch(`${this.base}/api/merchant/merchantDetailsForThirdParty/v2/login`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${body.username}:${body.password}`).toString("base64")}`, signature: this.sign(body) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => this.fail("Fonepay OAuth network request failed"));
    const data = await response.json().catch(() => ({})) as { accessToken?: string };
    if (!response.ok || !data.accessToken) return this.fail("Fonepay OAuth authentication failed");
    this.token = { value: data.accessToken.replace(/^Bearer\s+/i, ""), expiresAt: Date.now() + 10 * 60_000 };
    return this.token.value;
  }
  private async request(path: string, method: "GET" | "POST", body?: Record<string, unknown>, extra: Record<string, string> = {}) {
    const token = await this.auth(); const payload = body ?? {};
    const response = await fetch(`${this.base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, signature: this.sign(payload), ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...extra }, ...(method === "POST" ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15_000) }).catch(() => this.fail(`Fonepay ${path} network request failed`));
    const data = await response.json().catch(() => ({})); if (!response.ok) return this.fail(`Fonepay ${path} failed (${response.status})`); return data as Record<string, unknown>;
  }
  async initiate(input: { orderId: string; orderNumber: string; amountNpr: number; returnUrl: string }): Promise<PaymentInitiation> {
    const reference = `VC${input.orderId.replace(/-/g, "").slice(0, 24)}`;
    const banks = await this.request("/api/merchant/third-party/v2/banks/list", "GET", undefined, { paymentMode: "INTENT" });
    const qr = await this.request("/api/merchant/third-party/v2/generate-intent-qr", "POST", { amount: input.amountNpr, billId: input.orderNumber, terminalId: process.env.FONEPAY_TERMINAL_ID!, paymentMode: "QR", referenceLabel: reference, qrType: "INTENT_QR" });
    const qrPayload = String(qr.qrMessage ?? qr.qrString ?? ""); if (!qrPayload) return this.fail("Fonepay QR response did not contain a QR payload");
    return { reference: String(qr.prn ?? reference), redirectUrl: "", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), correlationId: String(qr.prn ?? reference), qrPayload, qrDataUrl: await QRCode.toDataURL(qrPayload, { margin: 1, width: 360 }), ...(typeof qr.websocketId === "string" ? { websocketUrl: qr.websocketId } : {}), banks: Array.isArray(banks.bankDetails) ? banks.bankDetails as Bank[] : [] };
  }
  async verify(reference: string, context: PaymentContext): Promise<PaymentVerification> {
    const data = await this.request("/api/merchant/third-party/v2/thirdPartyDynamicQrGetStatus", "POST", { terminalId: process.env.FONEPAY_TERMINAL_ID!, referenceLabel: reference });
    const status = String(data.paymentStatus ?? "").toLowerCase();
    return { reference, orderId: context.orderId, amountNpr: Number(data.totalTransactionAmount ?? data.requestedAmount), currency: "NPR", ...(data.fonepayTraceId ? { providerTransactionId: String(data.fonepayTraceId) } : {}), status: status === "success" ? PaymentStatus.COMPLETED : status === "pending" ? PaymentStatus.PENDING : status === "cancelled" ? PaymentStatus.CANCELLED : PaymentStatus.FAILED };
  }
}
