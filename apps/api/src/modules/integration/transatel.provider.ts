import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ApiErrorCode, isRestrictedPlanCountry } from "@visa-compass/shared";
import { ApiException } from "../../common/api-error.js";
import type {
  ConnectivityProvider,
  ProvisionRequest,
  ProvisionResult,
  EsimDetailsResult,
  EligibilityResult,
  CatalogSyncResult,
  CatalogExportRow,
  CatalogExportResult,
  ProviderWebhookResult,
  ProviderWebhookEvent,
  UsageBreakdown,
  LifecycleResult,
  SubscriberDetailsResult,
} from "./connectivity-provider.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { resiliencePolicy } from "../../infrastructure/resilience-policy.js";
import { classifyProviderHttpFailure } from "./provider-failure.js";

/*
 * Raw Transatel OpenAPI DTOs. These types describe the external API contract and
 * MUST NOT leak past the ConnectivityProvider boundary (docs/ADR-002-provider-adapters.md).
 * Derived from the public OpenAPI specs served under /docs/api-docs for each domain.
 */

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

interface OrderProductResponse {
  id: string;
  orderReference: string;
  status: "done";
  submissionDate: string;
  bind?: { msisdn: string };
  source: string;
  mvnoRef: string;
  subscriptionId?: string;
  transactionReference?: string;
}

interface ESimDetailsResponse {
  simSerial: string;
  status:
    | "allocated"
    | "available"
    | "deleted"
    | "disabled"
    | "downloaded"
    | "enabled"
    | "installed"
    | "released";
  statusDate?: string;
  activationCode?: string;
  eid?: string;
  matchingId?: string;
  smdpAddress?: string;
  qrCode?: { value: string; dataUrl: string };
}

interface ScpBalance {
  resourceName: string;
  resourceLabel: string;
  resourceUnit: "KB" | "SECOND" | "SMS";
  resourceValue: number;
  resourceStartValue?: number;
  resourceStartDate: string;
  resourceEndDate: string;
}

type SubscriptionStatus =
  | "active"
  | "canceled"
  | "expired"
  | "pending"
  | "pendingForFirstUse"
  | "readyForUse"
  | "scheduled"
  | "suspended"
  | "terminated";

interface ProductSubscription {
  subscriptionId: string;
  status: SubscriptionStatus;
  productDefinition?: {
    productId: string;
    tags?: string[];
    productCategory?: "Add-on" | "One-off" | "Recurring";
    allowances?: unknown;
    countryList?: string[];
    validityPeriod?: {
      validityDuration: number;
      validityDurationUnit: "days" | "months";
    };
  };
  balances?: { data?: ScpBalance[] };
  activationDate?: string;
  expirationDate?: string;
}

interface ProductSubscriptionsResponse {
  currentLocale: string;
  productSubscriptions: ProductSubscription[];
}

interface Price {
  amount: number;
  currency: string;
  unit: string;
}

interface ProductDetails {
  availability: { available: boolean; startDate?: string; endDate?: string };
  canSubscribe: { allowed: boolean; errorKey?: string; errorMessage?: string };
  display?: { priority: number; shotMessage?: string };
  hasSubProducts: boolean;
  inventoryActive: boolean;
  prices?: { subscriptionFee?: Price[][]; renewalFee?: Price[][] };
  productDefinition: {
    productId: string;
    tags?: string[];
    productCategory?: "Add-on" | "One-off" | "Recurring";
    allowances?: unknown;
    countryList?: string[];
    validityPeriod?: {
      validityDuration: number;
      validityDurationUnit: "days" | "months";
    };
    description?: {
      productLabel?: string;
      productShortText?: string;
      productDetails?: string;
      productAllowances?: string;
      productPrice?: string;
      productValidityPeriod?: string;
    };
    unlimited?: boolean;
    parentProductIds?: string[];
  };
}

interface ProductCatalogResponse {
  cos: string;
  products: ProductDetails[];
}

interface ApiError {
  error?: string;
  error_description?: string;
  message?: string;
}

type Domain =
  | "authentication"
  | "ocs/subscriptions"
  | "ocs/inventory"
  | "ocs/catalog"
  | "sim-management/sims"
  | "connectivity-management/subscribers"
  | "webhooks";

@Injectable()
export class TransatelProvider implements ConnectivityProvider {
  private readonly logger = new Logger(TransatelProvider.name);
  readonly name = "TRANSATEL";

  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private tokenRefresh: Promise<string> | undefined;
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  private lastSuccessAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  capabilities() {
    return {
      catalogSync: true,
      provisioning: true,
      usage: true,
      esimDetails: true,
      topUp: true,
      callbacks: true,
    };
  }

  async health() {
    const configured = Boolean(
      process.env.TRANSATEL_BASE_URL &&
      process.env.TRANSATEL_CLIENT_ID &&
      process.env.TRANSATEL_CLIENT_SECRET &&
      process.env.TRANSATEL_MVNO_REF,
    );
    let authenticated = false;
    if (configured && !this.circuitOpen()) {
      try {
        await this.getAccessToken();
        authenticated = true;
      } catch {
        authenticated = false;
      }
    }
    return {
      ok: configured && authenticated && !this.circuitOpen(),
      baseUrl: process.env.TRANSATEL_BASE_URL ?? null,
      configured,
      authenticated,
      circuit: this.circuitOpen() ? "OPEN" : "CLOSED",
      lastSuccessAt: this.lastSuccessAt
        ? new Date(this.lastSuccessAt).toISOString()
        : null,
    };
  }

  private circuitOpen() {
    if (!this.circuitOpenedAt) return false;
    const cooldown = resiliencePolicy.connectivityCircuitResetMs();
    if (Date.now() - this.circuitOpenedAt >= cooldown) {
      this.circuitOpenedAt = 0;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  private providerSucceeded() {
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = 0;
    this.lastSuccessAt = Date.now();
  }
  private providerFailed() {
    this.consecutiveFailures += 1;
    const threshold = resiliencePolicy.connectivityCircuitFailures();
    if (this.consecutiveFailures >= threshold)
      this.circuitOpenedAt = Date.now();
  }

  private env(key: string): string {
    const value = process.env[key];
    if (!value)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_CONFIGURATION,
        message: "Connectivity service is not fully configured.",
        status: 503,
        details: `Missing environment variable: ${key}`,
      });
    return value;
  }

  private baseUrl(domain: Domain): string {
    const configured = (process.env.TRANSATEL_BASE_URL ?? "").replace(
      /\/+$/,
      "",
    );
    if (!configured)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_CONFIGURATION,
        message: "Connectivity service is not fully configured.",
        status: 503,
        details: "TRANSATEL_BASE_URL is not configured",
      });
    return configured.endsWith(`/${domain}`)
      ? configured
      : `${configured}/${domain}`;
  }

  private timeoutMs(): number {
    return resiliencePolicy.connectivityTimeoutMs();
  }

  private async getAccessToken(force = false): Promise<string> {
    const clientId = process.env.TRANSATEL_CLIENT_ID;
    const clientSecret = process.env.TRANSATEL_CLIENT_SECRET;
    if (!clientId || !clientSecret)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_CONFIGURATION,
        message: "Connectivity service is not fully configured.",
        status: 503,
        details: "Transatel API credentials are not fully configured",
      });

    if (!force && this.accessToken && Date.now() < this.tokenExpiry - 30_000)
      return this.accessToken;
    if (!force && this.tokenRefresh) return this.tokenRefresh;

    const refresh = this.fetchAccessToken(clientId, clientSecret);
    this.tokenRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.tokenRefresh === refresh) this.tokenRefresh = undefined;
    }
  }

  private async fetchAccessToken(
    clientId: string,
    clientSecret: string,
  ): Promise<string> {
    const tokenUrl = `${this.baseUrl("authentication")}/api/token`;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );
    this.logger.log("Fetching new Transatel access token...");
    const startedAt = Date.now();
    try {
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
      if (!response.ok) {
        const responseBody = await this.logBody(response);
        const detail = this.bodyText(responseBody);
        if (response.status === 429 || response.status >= 500)
          this.providerFailed();
        await this.record({
          operation: "token",
          method: "POST",
          endpoint: "/authentication/api/token",
          status: response.status,
          durationMs: Date.now() - startedAt,
          errorCode: "CONNECTIVITY_UNAVAILABLE",
          errorMessage: detail.slice(0, 2000),
          requestBody: { grant_type: "client_credentials" },
          responseBody: this.responseLogBody(response, responseBody),
        });
        throw new ApiException({
          code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
          message:
            "Our connectivity service is temporarily unavailable. Please try again shortly.",
          status: 503,
          details: `Transatel token exchange failed with status ${response.status}: ${detail}`,
        });
      }
      const data = (await response.json()) as TokenResponse;
      if (!data.access_token)
        throw new ApiException({
          code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
          message:
            "Our connectivity service is temporarily unavailable. Please try again shortly.",
          status: 503,
          details: "Transatel token response did not include an access_token",
        });
      await this.record({
        operation: "token",
        method: "POST",
        endpoint: "/authentication/api/token",
        status: 200,
        durationMs: Date.now() - startedAt,
        requestBody: { grant_type: "client_credentials" },
        responseBody: this.responseLogBody(response, this.redactLogBody(data)),
      });
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + data.expires_in * 1000;
      this.providerSucceeded();
      return this.accessToken;
    } catch (error) {
      if (error instanceof ApiException) throw error;
      this.providerFailed();
      this.logger.error("Transatel token request error", error);
      await this.record({
        operation: "token",
        method: "POST",
        endpoint: "/authentication/api/token",
        status: 0,
        durationMs: Date.now() - startedAt,
        errorCode: "NETWORK_ERROR",
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : "unknown error",
        requestBody: { grant_type: "client_credentials" },
      });
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message:
          "Our connectivity service is temporarily unavailable. Please try again shortly.",
        status: 503,
        details: `Transatel token request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  private async authorizedFetch(
    url: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
      retryOnAuth?: boolean;
      operation?: string;
      correlationId?: string;
    } = { method: "GET" },
  ): Promise<Response> {
    if (this.circuitOpen())
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message:
          "Our connectivity service is temporarily unavailable. Please try again shortly.",
        status: 503,
        details: "Transatel circuit breaker is open",
      });
    const {
      retryOnAuth = true,
      operation = "unknown",
      correlationId,
      ...request
    } = init;
    const startedAt = Date.now();
    const execute = async () => {
      const token = await this.getAccessToken();
      return fetch(url, {
        ...request,
        headers: {
          ...(request.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    };
    let response: Response;
    try {
      response = await execute();
    } catch (error) {
      this.providerFailed();
      await this.record({
        operation,
        method: request.method,
        endpoint: this.safeEndpoint(url),
        status: 0,
        durationMs: Date.now() - startedAt,
        errorCode: "NETWORK_ERROR",
        errorMessage:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : String(error).slice(0, 2000),
        ...(correlationId ? { correlationId } : {}),
        requestBody: this.requestLogPayload(url, request),
      });
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message:
          "Our connectivity service is temporarily unavailable. Please try again shortly.",
        status: 503,
        details:
          error instanceof Error
            ? `Transatel network request failed: ${error.message}`
            : "Transatel network request failed",
      });
    }
    if (response.status === 401 && retryOnAuth) {
      const responseBody = await this.logBody(response);
      await this.record({
        operation: `${operation}-auth-retry`,
        method: request.method,
        endpoint: this.safeEndpoint(url),
        status: 401,
        durationMs: Date.now() - startedAt,
        errorCode: "HTTP_401",
        errorMessage: this.bodyText(responseBody).slice(0, 2000),
        ...(correlationId ? { correlationId } : {}),
        requestBody: this.requestLogPayload(url, request),
        responseBody: this.responseLogBody(response, responseBody),
      });
      this.accessToken = null;
      this.tokenExpiry = 0;
      try {
        response = await execute();
      } catch (error) {
        this.providerFailed();
        await this.record({
          operation,
          method: request.method,
          endpoint: this.safeEndpoint(url),
          status: 0,
          durationMs: Date.now() - startedAt,
          errorCode: "NETWORK_ERROR",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : String(error).slice(0, 2000),
          ...(correlationId ? { correlationId } : {}),
          requestBody: this.requestLogPayload(url, request),
        });
        throw new ApiException({
          code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
          message:
            "Our connectivity service is temporarily unavailable. Please try again shortly.",
          status: 503,
          details:
            error instanceof Error
              ? `Transatel authentication retry failed: ${error.message}`
              : "Transatel authentication retry failed",
        });
      }
    }
    const durationMs = Date.now() - startedAt;
    let path: string;
    try {
      const parsed = new URL(url);
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      path = url;
    }
    if (response.ok) {
      this.providerSucceeded();
      await this.record({
        operation,
        method: request.method,
        endpoint: path,
        status: response.status,
        durationMs,
        ...(correlationId ? { correlationId } : {}),
        requestBody: this.requestLogPayload(url, request),
        responseBody: this.responseLogBody(
          response,
          await this.logBody(response),
        ),
      });
    } else {
      if (response.status === 429 || response.status >= 500)
        this.providerFailed();
      const responseBody = await this.logBody(response);
      const errorMessage = this.bodyText(responseBody).slice(0, 2000);
      await this.record({
        operation,
        method: request.method,
        endpoint: path,
        status: response.status,
        durationMs,
        ...(correlationId ? { correlationId } : {}),
        errorCode: `HTTP_${response.status}`,
        ...(errorMessage ? { errorMessage } : {}),
        requestBody: this.requestLogPayload(url, request),
        responseBody: this.responseLogBody(response, responseBody),
      });
    }
    return response;
  }

  private async record(entry: {
    operation: string;
    method: string;
    endpoint: string;
    status: number;
    durationMs: number;
    errorCode?: string;
    errorMessage?: string;
    correlationId?: string;
    requestBody?: Prisma.InputJsonValue;
    responseBody?: Prisma.InputJsonValue;
  }) {
    if (!this.prisma.enabled) return;
    try {
      await this.prisma.integrationLog.create({
        data: {
          operation: entry.operation,
          method: entry.method,
          endpoint: entry.endpoint,
          status: entry.status,
          durationMs: entry.durationMs,
          ...(entry.correlationId
            ? { correlationId: entry.correlationId }
            : {}),
          ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
          ...(entry.requestBody !== undefined
            ? { requestBody: entry.requestBody }
            : {}),
          ...(entry.responseBody !== undefined
            ? { responseBody: entry.responseBody }
            : {}),
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist integration log for ${entry.operation}`,
        error,
      );
    }
  }

  private parseRequestBody(body?: string): Prisma.InputJsonValue | undefined {
    if (!body) return undefined;
    try {
      return this.redactLogBody(JSON.parse(body));
    } catch {
      return body;
    }
  }

  private requestLogPayload(
    url: string,
    request: { method: string; body?: string },
  ): Prisma.InputJsonValue {
    const body = this.parseRequestBody(request.body);
    if (body !== undefined) return body;
    const parsed = new URL(url);
    return {
      method: request.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
    };
  }

  private async logBody(response: Response): Promise<Prisma.InputJsonValue> {
    try {
      const text = await response.clone().text();
      if (!text) return "";
      try {
        return this.redactLogBody(JSON.parse(text));
      } catch {
        return text.slice(0, 20_000);
      }
    } catch {
      return "Response body could not be read";
    }
  }

  private responseLogBody(
    response: Response,
    body: Prisma.InputJsonValue,
  ): Prisma.InputJsonValue {
    const providerRequestId = response.headers.get("x-tsl-request-id");
    return providerRequestId ? { providerRequestId, body } : body;
  }

  private bodyText(body: Prisma.InputJsonValue): string {
    return typeof body === "string" ? body : JSON.stringify(body);
  }

  private redactLogBody(value: unknown, depth = 0): Prisma.InputJsonValue {
    if (depth >= 8) return "[TRUNCATED]";
    if (Array.isArray(value))
      return value
        .slice(0, 100)
        .map((item) => this.redactLogBody(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 200)
          .map(([key, item]) => [
            key,
            /(^|_)(access_?token|refresh_?token|authorization|secret|password|api_?key|activation_?code|matching_?id|qr_?(code|payload)|data_?url)$/i.test(
              key,
            )
              ? "[REDACTED]"
              : this.redactLogBody(item, depth + 1),
          ]),
      );
    }
    if (typeof value === "string") return value.slice(0, 20_000);
    if (typeof value === "number" || typeof value === "boolean") return value;
    return "";
  }

  private async errorText(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as ApiError;
      return (
        data.error_description ??
        data.message ??
        data.error ??
        JSON.stringify(data)
      );
    } catch {
      return response.text();
    }
  }

  private async parseProviderJson<T>(
    response: Response,
    code: ApiErrorCode,
    message: string,
    contract: string,
  ): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiException({
        code,
        message,
        status: 502,
        details: `Transatel returned invalid JSON for ${contract}`,
      });
    }
  }

  /**
   * Resolves an internal reference (ICCID, order id or OCS subscription id) to
   * the inventory row backing the subscriber. Transatel binds orders via the
   * SIM's MSISDN (bind.msisdn) while the sim-serial endpoint keys on the ICCID.
   */
  private async resolveSubscriber(
    reference: string,
  ): Promise<{ iccid?: string; msisdn?: string }> {
    const sanitizeMsisdn = (val?: string | null) =>
      val && /^\d{6,15}$/.test(val.replace(/\D/g, ""))
        ? val.replace(/\D/g, "")
        : undefined;

    if (/^\d{19,20}$/.test(reference)) {
      if (this.prisma.enabled) {
        const inventory = await this.prisma.esimInventory.findFirst({
          where: { iccid: reference },
          select: { iccid: true, msisdn: true },
        });
        const msisdn = sanitizeMsisdn(inventory?.msisdn);
        return { iccid: reference, ...(msisdn ? { msisdn } : {}) };
      }
      return { iccid: reference };
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(reference))
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 404,
        details: `Could not resolve Transatel subscriber for reference: ${reference}`,
      });

    if (!this.prisma.enabled)
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 404,
        details: `Cannot resolve Transatel subscriber in memory mode for reference: ${reference}`,
      });

    const inventory = await this.prisma.esimInventory.findFirst({
      where: {
        OR: [
          { assignedOrderId: reference },
          { id: reference },
          { iccid: reference },
        ],
      },
      select: { iccid: true, msisdn: true },
    });
    if (inventory?.iccid) {
      const msisdn = sanitizeMsisdn(inventory.msisdn);
      return msisdn
        ? { iccid: inventory.iccid, msisdn }
        : { iccid: inventory.iccid };
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: reference },
      select: {
        customerEsim: {
          select: { inventory: { select: { iccid: true, msisdn: true } } },
        },
      },
    });
    if (subscription?.customerEsim?.inventory?.iccid) {
      const msisdn = sanitizeMsisdn(subscription.customerEsim.inventory.msisdn);
      return msisdn
        ? { iccid: subscription.customerEsim.inventory.iccid, msisdn }
        : { iccid: subscription.customerEsim.inventory.iccid };
    }

    const customerEsim = await this.prisma.customerEsim.findUnique({
      where: { orderId: reference },
      select: { inventory: { select: { iccid: true, msisdn: true } } },
    });
    if (customerEsim?.inventory?.iccid) {
      const msisdn = sanitizeMsisdn(customerEsim.inventory.msisdn);
      return msisdn
        ? { iccid: customerEsim.inventory.iccid, msisdn }
        : { iccid: customerEsim.inventory.iccid };
    }

    throw new ApiException({
      code: ApiErrorCode.USAGE_UNAVAILABLE,
      message:
        "Usage details are not available yet. Please check back shortly.",
      status: 404,
      details: `Could not resolve Transatel subscriber for reference: ${reference}`,
    });
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const mvnoRef = process.env.TRANSATEL_MVNO_REF;
    const isTopUp = request.purchaseType === "TOPUP";
    if (!mvnoRef)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_CONFIGURATION,
        message: "Connectivity service is not fully configured.",
        status: 503,
        details: "TRANSATEL_MVNO_REF is not configured",
      });

    const plan = await this.prisma.plan.findUnique({
      where: { id: request.planId },
    });
    if (!plan)
      throw new ApiException({
        code: ApiErrorCode.PLAN_NOT_AVAILABLE,
        message:
          "This plan is no longer available. Please choose another plan.",
        status: 404,
        details: `eSIM Plan not found for ID: ${request.planId}`,
      });
    if (!plan.providerPlanId)
      throw new ApiException({
        code: ApiErrorCode.PROVISIONING_FAILED,
        message:
          "We could not activate your eSIM right now. Our team is reviewing it and will contact you.",
        status: 502,
        details: `eSIM Plan ${request.planId} has no provider product id`,
      });

    const profile = await this.prisma.esimInventory.findFirst({
      where: {
        OR: [{ assignedOrderId: request.orderId }, { eid: request.eid }],
      },
    });
    if (!profile)
      throw new ApiException({
        code: ApiErrorCode.INVENTORY_UNAVAILABLE,
        message: "No eSIM is available right now. Please try again shortly.",
        status: 409,
        details: `No allocated eSIM profile found for EID: ${request.eid}`,
      });

    const validMsisdn =
      profile.msisdn && /^\d{6,15}$/.test(profile.msisdn.replace(/\D/g, ""))
        ? profile.msisdn.replace(/\D/g, "")
        : undefined;
    if (!validMsisdn)
      throw new ApiException({
        code: ApiErrorCode.PROVISIONING_FAILED,
        message:
          "We could not match this eSIM to its network number. Our support team is reviewing it.",
        status: 409,
        details: `Transatel OCS requires a 6-15 digit MSISDN; inventory ${profile.id} has no valid MSISDN`,
      });
    const bindMsisdn = validMsisdn;
    const existingOperation = this.prisma.enabled
      ? await this.prisma.provisioningOperation.findUnique({
          where: { orderId: request.orderId },
        })
      : null;
    const generation = existingOperation?.profileSwapCount ?? 0;
    const idempotencyKey =
      existingOperation?.idempotencyKey ??
      (generation > 0
        ? `transatel:${isTopUp ? "subscribe" : "preload"}:${request.orderId}:profile-${generation}`
        : `transatel:${isTopUp ? "subscribe" : "preload"}:${request.orderId}`);
    const operationPayload = {
      orderId: request.orderId,
      planId: request.planId,
      iccid: profile.iccid,
      msisdn: bindMsisdn,
      providerProductId: plan.providerPlanId,
    };
    if (this.prisma.enabled) {
      await this.prisma.provisioningOperation.upsert({
        where: { orderId: request.orderId },
        update: {
          iccid: profile.iccid,
          providerProductId: plan.providerPlanId,
          requestSnapshot: operationPayload,
        },
        create: {
          orderId: request.orderId,
          idempotencyKey,
          iccid: profile.iccid,
          providerProductId: plan.providerPlanId,
          requestSnapshot: operationPayload,
        },
      });
    }

    // A previous worker may have successfully submitted the preload and then
    // crashed before the QR became available. Never submit the command again:
    // resume the asynchronous read side using the durable provider reference.
    const accepted = await this.prisma.order.findUnique({
      where: { id: request.orderId },
      select: { providerSubscriptionId: true, providerStatus: true },
    });
    if (accepted?.providerSubscriptionId) {
      if (isTopUp)
        return {
          providerSubscriptionId: accepted.providerSubscriptionId,
          status: "COMPLETED",
        };
      try {
        const details = await this.getEsimDetails(profile.iccid);
        if (details.qrPayload) {
          if (this.prisma.enabled)
            await this.prisma.provisioningOperation.update({
              where: { orderId: request.orderId },
              data: {
                state: "QR_READY",
                completedAt: new Date(),
                nextReconcileAt: null,
                version: { increment: 1 },
              },
            });
          return {
            providerSubscriptionId: accepted.providerSubscriptionId,
            status: "COMPLETED",
            qrPayload: details.qrPayload,
            ...(details.smDpAddress
              ? { smDpAddress: details.smDpAddress }
              : {}),
          };
        }
      } catch (error) {
        this.logger.warn(
          `Accepted preload ${accepted.providerSubscriptionId} is still waiting for activation details: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      if (this.prisma.enabled)
        await this.prisma.provisioningOperation.update({
          where: { orderId: request.orderId },
          data: {
            state: "WAITING_FOR_QR",
            nextReconcileAt: new Date(Date.now() + 60_000),
            version: { increment: 1 },
          },
        });
      return {
        providerSubscriptionId: accepted.providerSubscriptionId,
        status: "DELAYED",
      };
    }
    if (accepted?.providerStatus === "SUBMITTING") {
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message:
          "Your eSIM activation is being reconciled. Please check back shortly.",
        status: 503,
        details: `Transatel preload outcome is unknown for order ${request.orderId}; refusing to submit a duplicate command`,
      });
    }

    // Obtain authentication before claiming the mutation: token failures are
    // known to occur before the provider command is sent and remain retryable.
    await this.getAccessToken();
    if (this.prisma.enabled) {
      const claimed = await this.prisma.order.updateMany({
        where: {
          id: request.orderId,
          providerSubscriptionId: null,
          providerStatus: null,
        },
        data: { providerStatus: "SUBMITTING" },
      });
      if (claimed.count !== 1) {
        throw new ApiException({
          code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
          message:
            "Your eSIM activation is already being processed. Please check back shortly.",
          status: 503,
          details: `Could not exclusively claim Transatel submission for order ${request.orderId}`,
        });
      }
      await this.prisma.provisioningOperation.update({
        where: { orderId: request.orderId },
        data: {
          state: "SUBMITTING",
          submittedAt: new Date(),
          attemptCount: { increment: 1 },
          lastErrorCategory: null,
          lastErrorMessage: null,
          version: { increment: 1 },
        },
      });
    }

    const orderUrl = `${this.baseUrl("ocs/subscriptions")}/api/orders/products`;
    const payload = {
      bind: { msisdn: bindMsisdn },
      source: "api",
      orderType: isTopUp ? "subscribe" : "preload",
      mvnoRef,
      product: { productId: plan.providerPlanId },
      payment: { provider: "customer" },
      transactionReference: request.orderId,
    };

    this.logger.log(
      `Submitting OCS ${isTopUp ? "subscribe" : "preload"} for ICCID ${profile.iccid}, product ${plan.providerPlanId}, order ${request.orderId}`,
    );
    let response: Response;
    try {
      response = await this.authorizedFetch(orderUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
        operation: "provision",
        correlationId: request.orderId,
      });
    } catch (error) {
      if (this.prisma.enabled)
        await this.prisma.provisioningOperation.update({
          where: { orderId: request.orderId },
          data: {
            state: "RECONCILE_REQUIRED",
            lastErrorCategory: "AMBIGUOUS_OUTCOME",
            lastErrorMessage:
              error instanceof Error
                ? error.message.slice(0, 2000)
                : "unknown error",
            nextReconcileAt: new Date(Date.now() + 60_000),
            reconcileDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000),
            version: { increment: 1 },
          },
        });
      throw error;
    }
    if (!response.ok) {
      const detail = await this.errorText(response);
      const failure = classifyProviderHttpFailure(
        response.status,
        response.headers.get("retry-after"),
      );
      this.logger.error(
        `OCS product ${isTopUp ? "subscribe" : "preload"} failed. Status: ${response.status}, Error: ${detail}`,
      );
      if (this.prisma.enabled)
        await this.prisma.provisioningOperation.update({
          where: { orderId: request.orderId },
          data: {
            state: failure.retryable ? "RECONCILE_REQUIRED" : "REJECTED",
            lastErrorCategory: failure.category,
            lastErrorMessage: detail.slice(0, 2000),
            nextReconcileAt: failure.retryable
              ? new Date(Date.now() + (failure.retryAfterMs ?? 60_000))
              : null,
            version: { increment: 1 },
          },
        });
      if (!failure.retryable && this.prisma.enabled)
        await this.prisma.order.update({
          where: { id: request.orderId },
          data: { providerStatus: "REJECTED", version: { increment: 1 } },
        });
      if (/SUBSCRIBER_STATUS_NOT_ELIGIBLE/i.test(detail))
        throw new ApiException({
          code: ApiErrorCode.ELIGIBILITY_REJECTED,
          message: isTopUp
            ? "This eSIM cannot receive a top-up in its current network state. Our support team can check its status before you try again."
            : "This eSIM cannot receive the selected plan right now. Please contact support or choose another plan.",
          status: 409,
          details: `PERMANENT_SUBSCRIBER_STATUS_NOT_ELIGIBLE: ${detail}`,
        });
      throw new ApiException({
        code: ApiErrorCode.PROVISIONING_FAILED,
        message:
          "We could not activate your eSIM right now. Our team is reviewing it and will contact you.",
        status: 502,
        details: `${failure.category}: OCS product activation failed: ${detail}`,
      });
    }

    const data = await this.parseProviderJson<OrderProductResponse>(
      response,
      ApiErrorCode.PROVISIONING_FAILED,
      "We could not activate your eSIM right now. Our team is reviewing it and will contact you.",
      "the OCS product order",
    );
    const providerSubscriptionId = data.subscriptionId;
    if (
      !providerSubscriptionId ||
      !data.id ||
      data.status?.toLowerCase() !== "done" ||
      data.mvnoRef !== mvnoRef ||
      data.bind?.msisdn?.replace(/\D/g, "") !== bindMsisdn ||
      (data.transactionReference &&
        data.transactionReference !== request.orderId)
    )
      throw new ApiException({
        code: ApiErrorCode.PROVISIONING_FAILED,
        message:
          "We could not activate your eSIM right now. Our team is reviewing it and will contact you.",
        status: 502,
        details:
          "OCS order response was incomplete or did not match the submitted MVNO, MSISDN, or transaction reference",
      });

    // Provider acceptance is the commit point. Persist it before any secondary
    // QR/details call so a crash or timeout cannot cause a duplicate preload or
    // make remotely-bound inventory look reusable.
    if (this.prisma.enabled) {
      await this.prisma.$transaction([
        this.prisma.order.update({
          where: { id: request.orderId },
          data: {
            providerSubscriptionId,
            providerStatus: isTopUp ? "SUBSCRIBED" : "PRELOADED",
            version: { increment: 1 },
          },
        }),
        ...(!isTopUp
          ? [
              this.prisma.esimInventory.update({
                where: { id: profile.id },
                data: {
                  providerSubscriptionId,
                  providerStatus: "PRELOADED",
                  version: { increment: 1 },
                },
              }),
            ]
          : []),
        this.prisma.provisioningOperation.update({
          where: { orderId: request.orderId },
          data: {
            state: "ACCEPTED",
            providerOrderId: data.id,
            providerSubscriptionId,
            responseSnapshot: data as unknown as Prisma.InputJsonValue,
            acceptedAt: new Date(),
            nextReconcileAt: new Date(Date.now() + 60_000),
            reconcileDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000),
            version: { increment: 1 },
          },
        }),
      ]);
    }

    // `subscribe` adds a package to an already-issued eSIM. The OCS 201/done
    // response is the commit point; no new activation QR is created or needed.
    if (isTopUp) {
      if (this.prisma.enabled)
        await this.prisma.provisioningOperation.update({
          where: { orderId: request.orderId },
          data: {
            state: "ACTIVATED",
            completedAt: new Date(),
            nextReconcileAt: null,
            version: { increment: 1 },
          },
        });
      return { providerSubscriptionId, status: "COMPLETED" };
    }

    try {
      const details = await this.getEsimDetails(profile.iccid);
      if (details.qrPayload) {
        if (this.prisma.enabled)
          await this.prisma.provisioningOperation.update({
            where: { orderId: request.orderId },
            data: {
              state: "QR_READY",
              completedAt: new Date(),
              nextReconcileAt: null,
              version: { increment: 1 },
            },
          });
        return {
          providerSubscriptionId,
          status: "COMPLETED",
          qrPayload: details.qrPayload,
          ...(details.smDpAddress ? { smDpAddress: details.smDpAddress } : {}),
        };
      }
    } catch (error) {
      // The preload has already succeeded. Details availability is an
      // asynchronous concern handled by webhooks/reconciliation, not a reason
      // to replay the mutating command.
      this.logger.warn(
        `Preload ${providerSubscriptionId} accepted but activation details are not ready: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (this.prisma.enabled)
      await this.prisma.provisioningOperation.update({
        where: { orderId: request.orderId },
        data: {
          state: "WAITING_FOR_QR",
          nextReconcileAt: new Date(Date.now() + 60_000),
          version: { increment: 1 },
        },
      });
    return { providerSubscriptionId, status: "DELAYED" };
  }

  async getUsage(subscriptionId: string): Promise<UsageBreakdown> {
    const subscriber = await this.resolveSubscriber(subscriptionId);
    const msisdn = subscriber.msisdn?.replace(/\D/g, "") ?? "";
    if (!/^\d{6,15}$/.test(msisdn))
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 404,
        details:
          "Transatel OCS inventory requires a 6-15 digit MSISDN; none is stored for this eSIM",
      });
    const url = `${this.baseUrl("ocs/inventory")}/api/subscriptions/products?msisdn=${encodeURIComponent(msisdn)}&withBalances=true`;
    this.logger.log(`Fetching inventory usage for MSISDN: ${msisdn}`);

    const response = await this.authorizedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      operation: "usage",
      correlationId: subscriptionId,
    });
    if (!response.ok)
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 502,
        details: `Failed to fetch usage balance from Transatel: ${await this.errorText(response)}`,
      });

    const data = await this.parseProviderJson<ProductSubscriptionsResponse>(
      response,
      ApiErrorCode.USAGE_UNAVAILABLE,
      "Usage details are not available yet. Please check back shortly.",
      "the OCS product inventory",
    );
    if (!Array.isArray(data.productSubscriptions))
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 502,
        details: "Transatel returned an invalid product inventory response",
      });
    if (
      data.productSubscriptions.some(
        (item) =>
          !item ||
          typeof item.subscriptionId !== "string" ||
          !item.subscriptionId.trim() ||
          typeof item.status !== "string" ||
          !item.status.trim(),
      )
    )
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 502,
        details: "Transatel returned an incomplete product subscription",
      });
    const subscriptions = data.productSubscriptions.filter(
      (item) => !item.productDefinition?.tags?.includes("WALLED_GARDEN"),
    );
    if (!subscriptions.length)
      throw new ApiException({
        code: ApiErrorCode.USAGE_UNAVAILABLE,
        message:
          "Usage details are not available yet. Please check back shortly.",
        status: 404,
        details: "No product subscription found for this subscriber",
      });

    const packages = subscriptions.map((item, index) => {
      const balance = this.usageFromBalances(
        item.balances,
        item.productDefinition?.allowances,
      );
      const activatedAt = this.validProviderDate(item.activationDate);
      const expiresAt = this.validProviderDate(item.expirationDate);
      return {
        providerSubscriptionId: item.subscriptionId,
        status: item.status,
        usedMb: balance?.usedMb ?? 0,
        totalMb: balance?.totalMb ?? 0,
        usageAvailable: Boolean(balance),
        priority: index + 1,
        ...(activatedAt ? { activatedAt } : {}),
        // Before activation expirationDate is an activation deadline, not plan expiry.
        ...(activatedAt && expiresAt ? { expiresAt } : {}),
      };
    });
    const aggregate = packages
      .filter((item) => item.usageAvailable && item.status === "active")
      .reduce(
        (total, item) => ({
          usedMb: total.usedMb + item.usedMb,
          totalMb: total.totalMb + item.totalMb,
        }),
        { usedMb: 0, totalMb: 0 },
      );
    return {
      ...aggregate,
      usageAvailable: packages.some(
        (item) => item.usageAvailable && item.status === "active",
      ),
      subscriptions: packages,
    };
  }

  private usageFromBalances(
    balances?: ProductSubscription["balances"],
    allowances?: unknown,
  ): { usedMb: number; totalMb: number } | null {
    const entries: ScpBalance[] = Array.isArray(balances?.data)
      ? balances!.data!
      : [];
    const dataResources = entries.filter(
      (entry) => String(entry.resourceUnit).toUpperCase() === "KB",
    );
    if (!dataResources.length) return null;
    const allowanceData =
      allowances && typeof allowances === "object"
        ? (allowances as { data?: unknown }).data
        : undefined;
    const allowanceResources = Array.isArray(allowanceData)
      ? allowanceData.filter(
          (entry): entry is { resourceName?: string; resourceValue: number } =>
            Boolean(entry) &&
            typeof entry === "object" &&
            String(
              (entry as { resourceUnit?: unknown }).resourceUnit,
            ).toUpperCase() === "KB" &&
            Number.isFinite(
              Number((entry as { resourceValue?: unknown }).resourceValue),
            ),
        )
      : [];
    const remaining = Math.max(
      ...dataResources.map((entry) =>
        Number(entry.resourceValue) >= 0 ? Number(entry.resourceValue) : 0,
      ),
      0,
    );
    const unlimited = dataResources.some(
      (entry) => Number(entry.resourceValue) === -1,
    );
    const start = Math.max(
      ...dataResources.map((entry) => {
        const reportedStart = Number(entry.resourceStartValue);
        if (Number.isFinite(reportedStart) && reportedStart > 0)
          return reportedStart;
        const configured = allowanceResources.find(
          (allowance) => allowance.resourceName === entry.resourceName,
        );
        const configuredValue = Number(configured?.resourceValue);
        if (Number.isFinite(configuredValue) && configuredValue > 0)
          return configuredValue;
        const current = Number(entry.resourceValue);
        return Number.isFinite(current) && current > 0 ? current : 0;
      }),
      0,
    );
    if (start <= 0 && !unlimited) return null;
    const totalMb = Math.max(1, Math.round(start / 1024));
    const remainingMb = unlimited
      ? totalMb
      : Math.min(totalMb, Math.round(remaining / 1024));
    return { usedMb: Math.max(0, totalMb - remainingMb), totalMb };
  }

  private validProviderDate(value?: string): string | undefined {
    return value && Number.isFinite(Date.parse(value)) ? value : undefined;
  }

  async getEsimDetails(reference: string): Promise<EsimDetailsResult> {
    const subscriber = await this.resolveSubscriber(reference);
    const iccid = subscriber.iccid ?? "";
    if (!iccid)
      throw new ApiException({
        code: ApiErrorCode.ESIM_NOT_FOUND,
        message: "This ICCID was not found in the Transatel inventory.",
        status: 404,
        details: "No ICCID found for the requested subscriber",
      });
    const url = `${this.baseUrl("sim-management/sims")}/api/esims/sim-serial/${encodeURIComponent(iccid)}`;
    this.logger.log(`Fetching eSIM details for ICCID: ${iccid}`);

    const response = await this.authorizedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      operation: "esim-details",
      correlationId: reference,
    });
    if (!response.ok) {
      const notFound = response.status === 404;
      throw new ApiException({
        code: notFound
          ? ApiErrorCode.ESIM_NOT_FOUND
          : ApiErrorCode.ESIM_LOOKUP_UNAVAILABLE,
        message: notFound
          ? "This ICCID was not found in the Transatel inventory."
          : "Transatel could not check this eSIM right now. Please retry shortly.",
        status: notFound ? 404 : 502,
        details: `Failed to query eSIM details from Transatel: ${await this.errorText(response)}`,
      });
    }

    const data = await this.parseProviderJson<ESimDetailsResponse>(
      response,
      ApiErrorCode.ESIM_LOOKUP_UNAVAILABLE,
      "Transatel could not check this eSIM right now. Please retry shortly.",
      "the eSIM profile lookup",
    );
    if (
      !data ||
      typeof data.status !== "string" ||
      !data.status.trim() ||
      (data.simSerial && data.simSerial !== iccid)
    )
      throw new ApiException({
        code: ApiErrorCode.ESIM_LOOKUP_UNAVAILABLE,
        message: "Transatel returned an invalid eSIM status response.",
        status: 502,
        details: "The eSIM response was incomplete or referenced another ICCID",
      });
    return {
      iccid,
      status: data.status,
      ...(data.smdpAddress ? { smDpAddress: data.smdpAddress } : {}),
      ...(data.qrCode?.value || data.activationCode
        ? { qrPayload: data.qrCode?.value ?? data.activationCode }
        : {}),
    };
  }

  async getSubscriberDetails(
    reference: string,
  ): Promise<SubscriberDetailsResult> {
    const subscriber = await this.resolveSubscriber(reference);
    const iccid = subscriber.iccid ?? "";
    if (!iccid)
      throw new ApiException({
        code: ApiErrorCode.ESIM_NOT_FOUND,
        message: "This ICCID was not found in the Transatel inventory.",
        status: 404,
        details: "No ICCID found for the requested subscriber",
      });
    const url = `${this.baseUrl("connectivity-management/subscribers")}/api/subscribers/sim-serial/${encodeURIComponent(iccid)}`;
    const response = await this.authorizedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      operation: "subscriber-details",
      correlationId: reference,
    });
    if (!response.ok)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Transatel could not check this subscriber right now.",
        status: response.status === 404 ? 404 : 502,
        details: await this.errorText(response),
      });
    const data = await this.parseProviderJson<{
      simSerial?: string;
      msisdn?: string;
      status?: string;
    }>(
      response,
      ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
      "Transatel could not check this subscriber right now.",
      "the connectivity subscriber lookup",
    );
    if (!data.status || (data.simSerial && data.simSerial !== iccid))
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Transatel returned an invalid subscriber status.",
        status: 502,
        details: data,
      });
    return {
      iccid,
      ...(data.msisdn ? { msisdn: data.msisdn } : {}),
      status: data.status,
    };
  }

  private async lifecycle(
    reference: string,
    action: "suspend" | "terminate",
    transactionReference: string,
  ): Promise<LifecycleResult> {
    const subscriber = await this.resolveSubscriber(reference);
    const simSerial = subscriber.iccid ?? "";
    if (!simSerial)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "The eSIM lifecycle action could not be submitted.",
        status: 404,
        details: `No ICCID found for ${reference}`,
      });
    const url = `${this.baseUrl("connectivity-management/subscribers")}/api/subscribers/sim-serial/${encodeURIComponent(simSerial)}/${action}`;
    const response = await this.authorizedFetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": transactionReference,
      },
      body: JSON.stringify({
        externalReference: transactionReference,
      }),
      operation: `subscriber-${action}`,
      correlationId: transactionReference,
    });
    if (!response.ok)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: `The eSIM ${action} request was rejected by Transatel.`,
        status: response.status >= 500 ? 503 : 409,
        details: await this.errorText(response),
      });
    const raw = await response.text();
    let data: {
      transactionId?: string;
      simSerial?: string;
      transactionStatus?: string;
      status?: string;
    };
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: `Transatel returned an invalid ${action} response.`,
        status: 502,
        details: "Connectivity lifecycle response was not valid JSON",
      });
    }
    const transactionStatus = data.transactionStatus ?? data.status;
    if (
      !data.transactionId ||
      (data.simSerial && data.simSerial !== simSerial) ||
      !transactionStatus ||
      !["PENDING", "DONE", "SUCCESS"].includes(transactionStatus.toUpperCase())
    )
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: `Transatel returned an invalid ${action} response.`,
        status: 502,
        details:
          "Connectivity lifecycle response was incomplete, unsuccessful, or referenced another ICCID",
      });
    return {
      accepted: true,
      transactionId: data.transactionId,
      status: transactionStatus.toUpperCase(),
    };
  }

  suspend(subscriptionId: string, transactionReference: string) {
    return this.lifecycle(subscriptionId, "suspend", transactionReference);
  }
  terminate(subscriptionId: string, transactionReference: string) {
    return this.lifecycle(subscriptionId, "terminate", transactionReference);
  }

  async syncCatalog(): Promise<CatalogSyncResult> {
    if (!this.prisma.enabled)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Catalog synchronization is unavailable right now.",
        status: 503,
        details: "Catalog sync requires database persistence",
      });
    const cos = process.env.TRANSATEL_COS || "WW_COS_UBG_MKP_EUR";
    const url = `${this.baseUrl("ocs/catalog")}/api/cos/${encodeURIComponent(cos)}/products?availabilityStatus=AVAILABLE&categories=One-off`;
    this.logger.log(`Synchronizing Transatel catalog for COS: ${cos}`);

    const response = await this.authorizedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "Accept-Language": "en_US" },
      operation: "catalog",
    });
    if (!response.ok)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Catalog synchronization is unavailable right now.",
        status: 502,
        details: `Transatel catalog fetch failed: ${await this.errorText(response)}`,
      });

    const data = await this.parseProviderJson<ProductCatalogResponse>(
      response,
      ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
      "Catalog synchronization is unavailable right now.",
      "the OCS catalog",
    );
    if (!Array.isArray(data.products))
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Catalog synchronization is unavailable right now.",
        status: 502,
        details: "Transatel returned an invalid OCS catalog response",
      });
    let synced = 0;
    const skipped: string[] = [];

    for (const product of data.products) {
      if (
        !product ||
        typeof product !== "object" ||
        !product.productDefinition
      ) {
        skipped.push("invalid-product");
        continue;
      }
      const definition = product.productDefinition;
      const countries = (definition.countryList ?? [])
        .map((iso3) => this.iso3ToIso2(iso3))
        .filter((iso2): iso2 is string => Boolean(iso2));
      if (!definition.productId || !countries.length) {
        skipped.push(definition.productId ?? "unknown-product");
        continue;
      }
      const validityDays = this.validityDays(definition.validityPeriod);
      if (validityDays <= 0) {
        skipped.push(definition.productId);
        continue;
      }
      const allowanceMb = this.allowanceMb(definition.allowances);
      const price = this.priceNpr(product.prices?.subscriptionFee);
      if (price === null) {
        skipped.push(definition.productId);
        continue;
      }

      const names = definition.description;
      const name =
        names?.productShortText || names?.productLabel || definition.productId;

      try {
        let syncedCountries = 0;
        await this.prisma.$transaction(async (tx) => {
          for (const isoCode of countries) {
            if (isRestrictedPlanCountry(isoCode)) continue;
            syncedCountries += 1;
            const country = await tx.country.upsert({
              where: { isoCode },
              update: { name: this.countryName(isoCode), active: true },
              create: { isoCode, name: this.countryName(isoCode) },
            });
            await tx.plan.upsert({
              where: {
                countryId_providerPlanId: {
                  countryId: country.id,
                  providerPlanId: definition.productId,
                },
              },
              update: {
                name,
                dataAllowance:
                  allowanceMb !== null ? `${allowanceMb} MB` : "Unlimited",
                validityDays,
                costPrice: price,
                coverage: definition.countryList ?? [],
              },
              create: {
                countryId: country.id,
                providerPlanId: definition.productId,
                name,
                dataAllowance:
                  allowanceMb !== null ? `${allowanceMb} MB` : "Unlimited",
                validityDays,
                costPrice: price,
                sellingPrice: price,
                coverage: definition.countryList ?? [],
                popular: false,
                // Newly discovered provider products require commercial
                // review before they become customer-visible.
                status: "DRAFT",
              },
            });
          }
        });
        synced += syncedCountries;
      } catch (error) {
        this.logger.error(
          `Failed to sync Transatel product ${definition.productId}: ${error instanceof Error ? error.message : "unknown"}`,
        );
        skipped.push(definition.productId);
      }
    }

    this.logger.log(
      `Transatel catalog sync finished: ${synced} plan(s) synced, ${skipped.length} skipped`,
    );
    return { synced, skipped: skipped.length };
  }

  /**
   * Fetches the Transatel catalog and returns normalized rows (no DB writes),
   * shaped so they can be re-imported via the plans import endpoint. Products
   * that can't be represented (no mapped country, invalid validity, missing
   * price/FX) are reported back in `skipped` instead of being persisted.
   */
  async catalogReport(cos?: string): Promise<CatalogExportResult> {
    const c = cos || process.env.TRANSATEL_COS || "WW_COS_UBG_MKP_EUR";
    const url = `${this.baseUrl("ocs/catalog")}/api/cos/${encodeURIComponent(c)}/products?availabilityStatus=AVAILABLE&categories=One-off`;

    const response = await this.authorizedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "Accept-Language": "en_US" },
      operation: "catalog",
    });
    if (!response.ok)
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Catalog export is unavailable right now.",
        status: 502,
        details: `Transatel catalog fetch failed: ${await this.errorText(response)}`,
      });

    const data = await this.parseProviderJson<ProductCatalogResponse>(
      response,
      ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
      "Catalog export is unavailable right now.",
      "the OCS catalog export",
    );
    if (!Array.isArray(data.products))
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message: "Catalog export is unavailable right now.",
        status: 502,
        details: "Transatel returned an invalid OCS catalog response",
      });
    const rows: CatalogExportRow[] = [];
    const skipped: string[] = [];

    for (const product of data.products) {
      if (
        !product ||
        typeof product !== "object" ||
        !product.productDefinition
      ) {
        skipped.push("invalid-product");
        continue;
      }
      const definition = product.productDefinition;
      const countries = (definition.countryList ?? [])
        .map((iso3) => this.iso3ToIso2(iso3))
        .filter((iso2): iso2 is string => Boolean(iso2));
      if (!definition.productId || !countries.length) {
        skipped.push(definition.productId ?? "unknown-product");
        continue;
      }
      const validityDays = this.validityDays(definition.validityPeriod);
      if (validityDays <= 0) {
        skipped.push(definition.productId);
        continue;
      }
      const allowanceMb = this.allowanceMb(definition.allowances);
      const price = this.priceNpr(product.prices?.subscriptionFee);
      if (price === null) {
        skipped.push(definition.productId);
        continue;
      }
      const names = definition.description;
      const name =
        names?.productShortText || names?.productLabel || definition.productId;

      for (const isoCode of countries) {
        if (isRestrictedPlanCountry(isoCode)) continue;
        rows.push({
          countryiso2: isoCode,
          countryname: this.countryName(isoCode),
          name,
          providerplanid: definition.productId,
          dataallowance:
            allowanceMb !== null ? `${allowanceMb} MB` : "Unlimited",
          validitydays: validityDays,
          costprice: price,
          sellingprice: price,
          currency: "NPR",
          coveragecountries: (definition.countryList ?? []).join("|"),
          status: "",
        });
      }
    }

    return { rows, skipped };
  }

  async checkEligibility(
    planId: string,
    msisdn: string,
  ): Promise<EligibilityResult> {
    if (!this.prisma.enabled) return { allowed: true };
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan?.providerPlanId)
      throw new ApiException({
        code: ApiErrorCode.PLAN_NOT_AVAILABLE,
        message:
          "This plan is no longer available. Please choose another plan.",
        status: 404,
        details: "Plan not found or has no provider product id",
      });
    const cos = process.env.TRANSATEL_COS || "WW_COS_UBG_MKP_EUR";
    const url = `${this.baseUrl("ocs/catalog")}/api/cos/${encodeURIComponent(cos)}/products/${encodeURIComponent(plan.providerPlanId)}?msisdn=${encodeURIComponent(msisdn)}`;

    const response = await this.authorizedFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "Accept-Language": "en_US" },
      operation: "eligibility",
    });
    if (!response.ok) {
      const detail = await this.errorText(response);
      if (response.status === 403 || response.status === 404) {
        return {
          allowed: false,
          errorKey: "ELIGIBILITY_REJECTED",
          errorMessage:
            "This eSIM is not available for the number you provided. Please check and try again.",
        };
      }
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message:
          "Our connectivity service is temporarily unavailable. Please try again shortly.",
        status: 502,
        details: `Transatel eligibility check failed: ${detail}`,
      });
    }
    const data = await this.parseProviderJson<
      ProductDetails | ProductCatalogResponse
    >(
      response,
      ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
      "Our connectivity service is temporarily unavailable. Please try again shortly.",
      "the OCS eligibility lookup",
    );
    // Transatel deployments have exposed the product-detail response both as
    // the product itself and wrapped in a `products` collection. Accept both
    // documented shapes so eligibility never becomes a false rejection merely
    // because the tenant is on a different compatible API revision.
    const details =
      data && typeof data === "object" && "canSubscribe" in data
        ? data
        : Array.isArray(data.products)
          ? data.products[0]
          : undefined;
    const allowed = Boolean(details?.canSubscribe?.allowed);
    if (!allowed) {
      const providerCode = details?.canSubscribe?.errorKey;
      return {
        allowed: false,
        errorKey: providerCode ?? "ELIGIBILITY_REJECTED",
        errorMessage: /SUBSCRIBER_STATUS_NOT_ELIGIBLE/i.test(providerCode ?? "")
          ? "This eSIM cannot receive a top-up in its current network state. Please contact support before trying again."
          : "This eSIM cannot receive the selected plan right now. Please contact support or choose another plan.",
      };
    }
    return {
      allowed: true,
    };
  }

  async handleWebhook(payload: unknown): Promise<ProviderWebhookResult> {
    const envelope = this.normalizeEnvelope(payload);
    const eventType = envelope.eventType;
    if (!eventType)
      return {
        handled: false,
        reason: "Webhook payload is missing header.eventType",
      };
    const eventStatus = this.mapEventType(eventType);
    if (eventStatus === "OTHER")
      return {
        handled: false,
        reason: `Webhook event ${eventType} is not supported by the lifecycle mapper`,
      };
    if (
      envelope.productId
        ?.toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .includes("WALLEDGARDEN")
    )
      return {
        handled: false,
        reason: `Webhook event ${eventType} belongs to Transatel's infrastructure walled-garden product`,
      };

    const iccid = envelope.iccid;
    if (!iccid)
      return {
        handled: false,
        reason: `Webhook ${eventType} did not carry a subscriber identifier`,
      };

    let orderId: string | undefined;
    if (this.prisma.enabled) {
      const subscriberEvent = eventType.startsWith(
        "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/",
      );
      const lifecycleAction =
        eventStatus === "SUSPENDED"
          ? "SUSPEND"
          : eventStatus === "TERMINATED"
            ? "TERMINATE"
            : null;
      if (subscriberEvent && lifecycleAction) {
        const pendingLifecycle =
          await this.prisma.transatelLifecycleOperation.findFirst({
            where: {
              action: lifecycleAction,
              state: {
                in: ["CREATED", "SUBMITTING", "ACCEPTED", "RECONCILE_REQUIRED"],
              },
              order: {
                OR: [
                  { inventory: { is: { iccid } } },
                  { targetInventory: { is: { iccid } } },
                  { customerEsim: { is: { inventory: { is: { iccid } } } } },
                ],
              },
            },
            select: { orderId: true },
            orderBy: { createdAt: "desc" },
          });
        if (pendingLifecycle) orderId = pendingLifecycle.orderId;
      }
      // Bind the event to an order by our own transaction/order reference first
      // (Transatel echoes it back as body.externalReference), falling back to the
      // provider subscription id, and finally an unambiguous SIM serial.
      // A SIM can have many top-up orders, so blindly using its original
      // assignedOrderId would apply a top-up event to the wrong order.
      if (!orderId && envelope.externalReference) {
        const order = await this.prisma.order.findUnique({
          where: { id: envelope.externalReference },
          select: { id: true },
        });
        if (order) orderId = order.id;
      }
      if (!orderId && envelope.subscriptionId) {
        const order = await this.prisma.order.findFirst({
          where: { providerSubscriptionId: envelope.subscriptionId },
          select: { id: true },
        });
        if (order) orderId = order.id;
      }
      if (!orderId && envelope.subscriptionId) {
        const subscription = await this.prisma.subscription.findUnique({
          where: { providerSubscriptionId: envelope.subscriptionId },
          select: { customerEsim: { select: { orderId: true } } },
        });
        if (subscription) orderId = subscription.customerEsim.orderId;
      }
      if (!orderId) {
        const inventory = await this.prisma.esimInventory.findUnique({
          where: { iccid },
          select: {
            assignedOrderId: true,
            customerEsims: { select: { orderId: true }, take: 2 },
          },
        });
        const candidates = new Set(
          [
            inventory?.assignedOrderId,
            ...(inventory?.customerEsims ?? []).map((item) => item.orderId),
          ].filter((candidate): candidate is string => Boolean(candidate)),
        );
        if (subscriberEvent && inventory?.assignedOrderId)
          orderId = inventory.assignedOrderId;
        else if (candidates.size === 1) orderId = [...candidates][0];
        else if (candidates.size > 1)
          return {
            handled: false,
            reason: `Webhook ${eventType} for ICCID ${iccid} is ambiguous across ${candidates.size} orders and did not carry a usable externalReference or subscriptionId`,
          };
      }
    }
    if (!orderId)
      return {
        handled: false,
        reason: `No order found for event ${eventType} (externalReference ${envelope.externalReference ?? "n/a"}, ICCID ${iccid})`,
      };

    const event: ProviderWebhookEvent = {
      eventType,
      statusScope: eventType.startsWith("CONNECTIVITY-MANAGEMENT/SUBSCRIBER/")
        ? "SUBSCRIBER"
        : "PRODUCT",
      orderId,
      iccid,
      ...(envelope.msisdn ? { msisdn: envelope.msisdn } : {}),
      ...(envelope.externalReference
        ? { externalReference: envelope.externalReference }
        : {}),
      ...(envelope.subscriptionId
        ? { subscriptionId: envelope.subscriptionId }
        : {}),
      ...(eventStatus ? { status: eventStatus } : {}),
      ...(envelope.activatedAt ? { activatedAt: envelope.activatedAt } : {}),
      ...(envelope.expiresAt ? { expiresAt: envelope.expiresAt } : {}),
    };

    if (event.status === "ACTIVATED" && this.prisma.enabled) {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      if (order && order.status !== "COMPLETED") {
        try {
          const details = await this.getEsimDetails(iccid);
          if (details.qrPayload) event.qrPayload = details.qrPayload;
        } catch (error) {
          this.logger.warn(
            `Could not enrich QR payload during ${eventType} for ICCID ${iccid}: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }
      }
    }

    return { handled: true, event };
  }

  /**
   * Normalizes an inbound Transatel OCS event to its canonical fields using the
   * exact field locations defined by the OCS events OpenAPI spec (v1.10):
   *   header.eventType
   *   body.iccid for OCS events or body.simSerial for connectivity-management events
   *   body.msisdn (required, [0-9]{6,15})
   *   body.externalReference (our transaction/order reference, echoed back)
   *   body.productSubscription.subscriptionId
   *   body.productSubscription.activationDate / expirationDate
   * No tolerant fallbacks: the spec marks body.iccid as required, so anything
   * that does not match exactly is rejected.
   */
  private normalizeEnvelope(payload: unknown): {
    eventType?: string;
    iccid?: string;
    msisdn?: string;
    subscriptionId?: string;
    productId?: string;
    externalReference?: string;
    activatedAt?: string;
    expiresAt?: string;
  } {
    const envelope =
      (payload as {
        header?: Record<string, unknown>;
        body?: Record<string, unknown>;
      }) ?? {};
    const header = envelope.header ?? {};
    const body = envelope.body ?? {};

    const eventType =
      typeof header.eventType === "string" ? header.eventType : undefined;
    const connectivityEvent = eventType?.startsWith(
      "CONNECTIVITY-MANAGEMENT/SUBSCRIBER/",
    );
    const iccid =
      typeof body.iccid === "string"
        ? body.iccid
        : connectivityEvent && typeof body.simSerial === "string"
          ? body.simSerial
          : undefined;
    const msisdn = typeof body.msisdn === "string" ? body.msisdn : undefined;
    const externalReference =
      typeof body.externalReference === "string"
        ? body.externalReference
        : undefined;

    const productSubscription = (body.productSubscription ?? {}) as Record<
      string,
      unknown
    >;
    const subscriptionId =
      typeof productSubscription.subscriptionId === "string"
        ? productSubscription.subscriptionId
        : undefined;
    const productDefinition =
      typeof productSubscription.productDefinition === "object" &&
      productSubscription.productDefinition !== null
        ? (productSubscription.productDefinition as Record<string, unknown>)
        : {};
    const productId =
      typeof productDefinition.productId === "string"
        ? productDefinition.productId
        : undefined;
    const activatedAt = this.validProviderDate(
      typeof productSubscription.activationDate === "string"
        ? productSubscription.activationDate
        : undefined,
    );
    const expiresAt = this.validProviderDate(
      typeof productSubscription.expirationDate === "string"
        ? productSubscription.expirationDate
        : undefined,
    );

    return {
      ...(eventType ? { eventType } : {}),
      ...(iccid ? { iccid } : {}),
      ...(msisdn ? { msisdn } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(productId ? { productId } : {}),
      ...(externalReference ? { externalReference } : {}),
      ...(activatedAt ? { activatedAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  private mapEventType(eventType: string): ProviderWebhookEvent["status"] {
    const normalized = eventType.toUpperCase();
    if (normalized.endsWith("REACTIVATED")) return "ACTIVATED";
    if (normalized.endsWith("ACTIVATED")) return "ACTIVATED";
    if (normalized.endsWith("SUSPENDED")) return "SUSPENDED";
    if (normalized.endsWith("PRELOADED")) return "PRELOADED";
    if (normalized.endsWith("EXPIRED")) return "EXPIRED";
    if (normalized.endsWith("TERMINATED")) return "TERMINATED";
    if (normalized.endsWith("CANCELED") || normalized.endsWith("CANCELLED"))
      return "CANCELED";
    return "OTHER";
  }

  private validityDays(
    validity?: ProductDetails["productDefinition"]["validityPeriod"],
  ): number {
    if (!validity?.validityDuration) return 0;
    const multiplier = validity.validityDurationUnit === "months" ? 30 : 1;
    return Math.max(1, validity.validityDuration * multiplier);
  }

  private allowanceMb(allowances: unknown): number | null {
    const data = this.allowanceEntries(allowances);
    if (!data.length) return null;
    const main =
      data.find((entry) => /^DATA/i.test(String(entry.resourceName ?? ""))) ??
      data[0];
    if (!main) return null;
    const value = Number(main.startValue);
    if (!Number.isFinite(value)) return null;
    const unit = String(main.unit ?? "MB").toUpperCase();
    if (unit === "GB") return Math.round(value * 1024);
    if (unit === "KB") return Math.max(1, Math.round(value / 1024));
    return Math.round(value);
  }

  private allowanceEntries(allowances: unknown): Array<{
    resourceName?: string;
    startValue?: number | string;
    unit?: string;
  }> {
    if (!allowances || typeof allowances !== "object") return [];
    const candidate = allowances as { data?: unknown; entries?: unknown };
    const list = Array.isArray(candidate.data)
      ? candidate.data
      : Array.isArray(candidate.entries)
        ? candidate.entries
        : null;
    return (list ?? [])
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)
          : {},
      )
      .map((entry) => ({
        ...(typeof entry.resourceName === "string"
          ? { resourceName: entry.resourceName }
          : typeof entry.name === "string"
            ? { resourceName: entry.name }
            : {}),
        ...(typeof entry.startValue === "number" ||
        typeof entry.startValue === "string"
          ? { startValue: entry.startValue }
          : typeof entry.resourceValue === "number" ||
              typeof entry.resourceValue === "string"
            ? { startValue: entry.resourceValue }
            : typeof entry.value === "number"
              ? { startValue: entry.value }
              : {}),
        ...(typeof entry.unit === "string"
          ? { unit: entry.unit }
          : typeof entry.resourceUnit === "string"
            ? { unit: entry.resourceUnit }
            : {}),
      }));
  }

  /** Converts the provider fee to NPR. Minor currency units are normalized
   * before applying the configured commercial FX rate. An invalid/missing
   * foreign-currency rate rejects the product instead of silently underpricing
   * it as if the provider amount were already NPR. */
  private priceNpr(fee?: Price[][]): number | null {
    if (!Array.isArray(fee) || !fee.length) return null;
    const first = Array.isArray(fee[0]) ? fee[0][0] : undefined;
    if (!first) return null;
    const amount = Number(first.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const minor = /^(CENT|CENTS)$/i.test(String(first.unit ?? ""));
    const majorValue = minor ? amount / 100 : amount;
    const currency = String(first.currency ?? "").toUpperCase();
    if (currency === "NPR") return Math.max(1, Math.round(majorValue));
    const fx = Number(process.env.TRANSATEL_FX_TO_NPR);
    if (!Number.isFinite(fx) || fx <= 0) return null;
    return Math.max(1, Math.round(majorValue * fx));
  }

  private safeEndpoint(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return url.split("?", 1)[0] ?? url;
    }
  }

  private iso3ToIso2(iso3: string): string | undefined {
    return ISO3_TO_ISO2[iso3.toUpperCase()];
  }

  private countryName(iso2: string): string {
    return ISO2_NAMES[iso2] ?? iso2;
  }
}

const ISO3_TO_ISO2: Record<string, string> = {
  AFG: "AF",
  ALB: "AL",
  DZA: "DZ",
  ASM: "AS",
  AND: "AD",
  AGO: "AO",
  ATG: "AG",
  ARG: "AR",
  ARM: "AM",
  AUS: "AU",
  AUT: "AT",
  AZE: "AZ",
  BHS: "BS",
  BHR: "BH",
  BGD: "BD",
  BRB: "BB",
  BLR: "BY",
  BEL: "BE",
  BLZ: "BZ",
  BEN: "BJ",
  BTN: "BT",
  BOL: "BO",
  BIH: "BA",
  BWA: "BW",
  BRA: "BR",
  BRN: "BN",
  BGR: "BG",
  BFA: "BF",
  BDI: "BI",
  KHM: "KH",
  CMR: "CM",
  CAN: "CA",
  CPV: "CV",
  CAF: "CF",
  TCD: "TD",
  CHL: "CL",
  CHN: "CN",
  COL: "CO",
  COM: "KM",
  COG: "CG",
  COD: "CD",
  CRI: "CR",
  CIV: "CI",
  HRV: "HR",
  CUB: "CU",
  CYP: "CY",
  CZE: "CZ",
  DNK: "DK",
  DJI: "DJ",
  DMA: "DM",
  DOM: "DO",
  ECU: "EC",
  EGY: "EG",
  SLV: "SV",
  GNQ: "GQ",
  ERI: "ER",
  EST: "EE",
  SWZ: "SZ",
  ETH: "ET",
  FJI: "FJ",
  FIN: "FI",
  FRA: "FR",
  GAB: "GA",
  GMB: "GM",
  GEO: "GE",
  DEU: "DE",
  GHA: "GH",
  GRC: "GR",
  GRD: "GD",
  GTM: "GT",
  GIN: "GN",
  GNB: "GW",
  GUY: "GY",
  HTI: "HT",
  HND: "HN",
  HUN: "HU",
  ISL: "IS",
  IND: "IN",
  IDN: "ID",
  IRN: "IR",
  IRQ: "IQ",
  IRL: "IE",
  ISR: "IL",
  ITA: "IT",
  JAM: "JM",
  JPN: "JP",
  JOR: "JO",
  KAZ: "KZ",
  KEN: "KE",
  KIR: "KI",
  PRK: "KP",
  KOR: "KR",
  KWT: "KW",
  KGZ: "KG",
  LAO: "LA",
  LVA: "LV",
  LBN: "LB",
  LSO: "LS",
  LBR: "LR",
  LBY: "LY",
  LIE: "LI",
  LTU: "LT",
  LUX: "LU",
  MDG: "MG",
  MWI: "MW",
  MYS: "MY",
  MDV: "MV",
  MLI: "ML",
  MLT: "MT",
  MHL: "MH",
  MRT: "MR",
  MUS: "MU",
  MEX: "MX",
  FSM: "FM",
  MDA: "MD",
  MCO: "MC",
  MNG: "MN",
  MNE: "ME",
  MAR: "MA",
  MOZ: "MZ",
  MMR: "MM",
  NAM: "NA",
  NRU: "NR",
  NPL: "NP",
  NLD: "NL",
  NZL: "NZ",
  NIC: "NI",
  NER: "NE",
  NGA: "NG",
  MKD: "MK",
  NOR: "NO",
  OMN: "OM",
  PAK: "PK",
  PLW: "PW",
  PAN: "PA",
  PNG: "PG",
  PRY: "PY",
  PER: "PE",
  PHL: "PH",
  POL: "PL",
  PRT: "PT",
  QAT: "QA",
  ROU: "RO",
  RUS: "RU",
  RWA: "RW",
  KNA: "KN",
  LCA: "LC",
  VCT: "VC",
  WSM: "WS",
  SMR: "SM",
  STP: "ST",
  SAU: "SA",
  SEN: "SN",
  SRB: "RS",
  SYC: "SC",
  SLE: "SL",
  SGP: "SG",
  SVK: "SK",
  SVN: "SI",
  SLB: "SB",
  SOM: "SO",
  ZAF: "ZA",
  SSD: "SS",
  ESP: "ES",
  LKA: "LK",
  SDN: "SD",
  SUR: "SR",
  SWE: "SE",
  CHE: "CH",
  SYR: "SY",
  TWN: "TW",
  TJK: "TJ",
  TZA: "TZ",
  THA: "TH",
  TLS: "TL",
  TGO: "TG",
  TON: "TO",
  TTO: "TT",
  TUN: "TN",
  TUR: "TR",
  TKM: "TM",
  TUV: "TV",
  UGA: "UG",
  UKR: "UA",
  ARE: "AE",
  GBR: "GB",
  USA: "US",
  URY: "UY",
  UZB: "UZ",
  VUT: "VU",
  VAT: "VA",
  VEN: "VE",
  VNM: "VN",
  YEM: "YE",
  ZMB: "ZM",
  ZWE: "ZW",
};

const ISO2_NAMES: Record<string, string> = {
  AF: "Afghanistan",
  AL: "Albania",
  DZ: "Algeria",
  AD: "Andorra",
  AO: "Angola",
  AG: "Antigua and Barbuda",
  AR: "Argentina",
  AM: "Armenia",
  AU: "Australia",
  AT: "Austria",
  AZ: "Azerbaijan",
  BS: "Bahamas",
  BH: "Bahrain",
  BD: "Bangladesh",
  BB: "Barbados",
  BY: "Belarus",
  BE: "Belgium",
  BZ: "Belize",
  BJ: "Benin",
  BT: "Bhutan",
  BO: "Bolivia",
  BA: "Bosnia and Herzegovina",
  BW: "Botswana",
  BR: "Brazil",
  BN: "Brunei",
  BG: "Bulgaria",
  BF: "Burkina Faso",
  BI: "Burundi",
  CV: "Cape Verde",
  KH: "Cambodia",
  CM: "Cameroon",
  CA: "Canada",
  CF: "Central African Republic",
  TD: "Chad",
  CL: "Chile",
  CN: "China",
  CO: "Colombia",
  KM: "Comoros",
  CG: "Congo",
  CR: "Costa Rica",
  HR: "Croatia",
  CU: "Cuba",
  CY: "Cyprus",
  CZ: "Czechia",
  DK: "Denmark",
  DJ: "Djibouti",
  DM: "Dominica",
  DO: "Dominican Republic",
  EC: "Ecuador",
  EG: "Egypt",
  SV: "El Salvador",
  GQ: "Equatorial Guinea",
  ER: "Eritrea",
  EE: "Estonia",
  SZ: "Eswatini",
  ET: "Ethiopia",
  FJ: "Fiji",
  FI: "Finland",
  FR: "France",
  GA: "Gabon",
  GM: "Gambia",
  GE: "Georgia",
  DE: "Germany",
  GH: "Ghana",
  GR: "Greece",
  GD: "Grenada",
  GT: "Guatemala",
  GN: "Guinea",
  GW: "Guinea-Bissau",
  GY: "Guyana",
  HT: "Haiti",
  HN: "Honduras",
  HU: "Hungary",
  IS: "Iceland",
  IN: "India",
  ID: "Indonesia",
  IR: "Iran",
  IQ: "Iraq",
  IE: "Ireland",
  IL: "Israel",
  IT: "Italy",
  JM: "Jamaica",
  JP: "Japan",
  JO: "Jordan",
  KZ: "Kazakhstan",
  KE: "Kenya",
  KI: "Kiribati",
  KR: "South Korea",
  KW: "Kuwait",
  KG: "Kyrgyzstan",
  LA: "Laos",
  LV: "Latvia",
  LB: "Lebanon",
  LS: "Lesotho",
  LR: "Liberia",
  LY: "Libya",
  LI: "Liechtenstein",
  LT: "Lithuania",
  LU: "Luxembourg",
  MG: "Madagascar",
  MW: "Malawi",
  MY: "Malaysia",
  MV: "Maldives",
  ML: "Mali",
  MT: "Malta",
  MH: "Marshall Islands",
  MR: "Mauritania",
  MU: "Mauritius",
  MX: "Mexico",
  FM: "Micronesia",
  MD: "Moldova",
  MC: "Monaco",
  MN: "Mongolia",
  ME: "Montenegro",
  MA: "Morocco",
  MZ: "Mozambique",
  MM: "Myanmar",
  NA: "Namibia",
  NR: "Nauru",
  NP: "Nepal",
  NL: "Netherlands",
  NZ: "New Zealand",
  NI: "Nicaragua",
  NE: "Niger",
  NG: "Nigeria",
  MK: "North Macedonia",
  NO: "Norway",
  OM: "Oman",
  PK: "Pakistan",
  PW: "Palau",
  PA: "Panama",
  PG: "Papua New Guinea",
  PY: "Paraguay",
  PE: "Peru",
  PH: "Philippines",
  PL: "Poland",
  PT: "Portugal",
  QA: "Qatar",
  RO: "Romania",
  RU: "Russia",
  RW: "Rwanda",
  KN: "Saint Kitts and Nevis",
  LC: "Saint Lucia",
  VC: "Saint Vincent and the Grenadines",
  WS: "Samoa",
  SM: "San Marino",
  ST: "Sao Tome and Principe",
  SA: "Saudi Arabia",
  SN: "Senegal",
  RS: "Serbia",
  SC: "Seychelles",
  SL: "Sierra Leone",
  SG: "Singapore",
  SK: "Slovakia",
  SI: "Slovenia",
  SB: "Solomon Islands",
  SO: "Somalia",
  ZA: "South Africa",
  SS: "South Sudan",
  ES: "Spain",
  LK: "Sri Lanka",
  SD: "Sudan",
  SR: "Suriname",
  SE: "Sweden",
  CH: "Switzerland",
  SY: "Syria",
  TW: "Taiwan",
  TJ: "Tajikistan",
  TZ: "Tanzania",
  TH: "Thailand",
  TL: "Timor-Leste",
  TG: "Togo",
  TO: "Tonga",
  TT: "Trinidad and Tobago",
  TN: "Tunisia",
  TR: "Türkiye",
  TM: "Turkmenistan",
  TV: "Tuvalu",
  UG: "Uganda",
  UA: "Ukraine",
  AE: "United Arab Emirates",
  GB: "United Kingdom",
  US: "United States",
  UY: "Uruguay",
  UZ: "Uzbekistan",
  VU: "Vanuatu",
  VA: "Vatican City",
  VE: "Venezuela",
  VN: "Vietnam",
  YE: "Yemen",
  ZM: "Zambia",
  ZW: "Zimbabwe",
};
