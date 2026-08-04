import { Injectable, Logger } from '@nestjs/common';
import { ApiErrorCode } from '@visa-compass/shared';
import { ApiException } from '../../common/api-error.js';
import type { ConnectivityProvider, ProvisionRequest, ProvisionResult, EsimDetailsResult, EligibilityResult, CatalogSyncResult, ProviderWebhookResult, ProviderWebhookEvent } from './connectivity-provider.js';
import { PrismaService } from '../../infrastructure/prisma.service.js';

/*
 * Raw Transatel OpenAPI DTOs. These types describe the external API contract and
 * MUST NOT leak past the ConnectivityProvider boundary (docs/ADR-002-provider-adapters.md).
 * Derived from the public OpenAPI specs served under /docs/api-docs for each domain.
 */

interface TokenResponse { access_token: string; expires_in: number; token_type?: string; scope?: string; }

interface OrderProductResponse {
  id: string;
  orderReference: string;
  status: 'done';
  submissionDate: string;
  bind?: { msisdn: string };
  source: string;
  mvnoRef: string;
  subscriptionId?: string;
  transactionReference?: string;
}

interface ESimDetailsResponse {
  simSerial: string;
  status: 'allocated' | 'available' | 'deleted' | 'disabled' | 'downloaded' | 'enabled' | 'installed' | 'released';
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
  resourceUnit: 'KB' | 'SECOND' | 'SMS';
  resourceValue: number;
  resourceStartValue: number;
  resourceStartDate: string;
  resourceEndDate: string;
}

type SubscriptionStatus = 'active' | 'pending' | 'pendingForFirstUse' | 'readyForUse' | 'scheduled' | 'terminated';

interface ProductSubscription {
  subscriptionId: string;
  status: SubscriptionStatus;
  productDefinition?: {
    productId: string;
    productCategory?: 'Add-on' | 'One-off' | 'Recurring';
    allowances?: unknown;
    countryList?: string[];
    validityPeriod?: { validityDuration: number; validityDurationUnit: 'days' | 'months' };
  };
  balances?: { data?: ScpBalance[] };
  activationDate?: string;
  expirationDate?: string;
}

interface ProductSubscriptionsResponse { currentLocale: string; productSubscriptions: ProductSubscription[]; }

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
    productCategory?: 'Add-on' | 'One-off' | 'Recurring';
    allowances?: unknown;
    countryList?: string[];
    validityPeriod?: { validityDuration: number; validityDurationUnit: 'days' | 'months' };
    description?: {
      productLabel?: string;
      productShortText?: string;
      productDetails?: string;
      productAllowances?: string;
      productPrice?: string;
      productValidityPeriod?: string;
    };
    unlimited?: boolean;
    tags?: string[];
    parentProductIds?: string[];
  };
}

interface ProductCatalogResponse { cos: string; products: ProductDetails[]; }

interface WebhookResponse {
  id: string;
  mvnoRef: string;
  status: 'active' | 'inactive' | 'suspended';
  targetUrl: string;
  email: string;
  events: Array<string | { eventType: string }>;
}

interface WebhooksResponse { webhooks: WebhookResponse[]; }

interface ApiError { error?: string; error_description?: string; message?: string; }

type Domain = 'authentication' | 'ocs/subscriptions' | 'ocs/inventory' | 'ocs/catalog' | 'sim-management/sims' | 'webhooks';

@Injectable()
export class TransatelProvider implements ConnectivityProvider {
  private readonly logger = new Logger(TransatelProvider.name);
  readonly name = 'TRANSATEL';

  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(private readonly prisma: PrismaService) {}

  capabilities() {
    return { catalogSync: true, provisioning: true, usage: true, esimDetails: true, topUp: true, callbacks: true };
  }

  async health() {
    return {
      ok: Boolean(process.env.TRANSATEL_BASE_URL && process.env.TRANSATEL_CLIENT_ID && process.env.TRANSATEL_CLIENT_SECRET && process.env.TRANSATEL_MVNO_REF),
      baseUrl: process.env.TRANSATEL_BASE_URL ?? null,
      configured: Boolean(process.env.TRANSATEL_BASE_URL && process.env.TRANSATEL_CLIENT_ID && process.env.TRANSATEL_CLIENT_SECRET && process.env.TRANSATEL_MVNO_REF),
    };
  }

  private env(key: string): string {
    const value = process.env[key];
    if (!value) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_CONFIGURATION, message: 'Connectivity service is not fully configured.', status: 503, details: `Missing environment variable: ${key}` });
    return value;
  }

  private baseUrl(domain: Domain): string {
    const configured = (process.env.TRANSATEL_BASE_URL ?? '').replace(/\/+$/, '');
    if (!configured) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_CONFIGURATION, message: 'Connectivity service is not fully configured.', status: 503, details: 'TRANSATEL_BASE_URL is not configured' });
    return configured.endsWith(`/${domain}`) ? configured : `${configured}/${domain}`;
  }

  private timeoutMs(): number {
    const parsed = Number(process.env.TRANSATEL_REQUEST_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
  }

  private async getAccessToken(force = false): Promise<string> {
    const clientId = process.env.TRANSATEL_CLIENT_ID;
    const clientSecret = process.env.TRANSATEL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_CONFIGURATION, message: 'Connectivity service is not fully configured.', status: 503, details: 'Transatel API credentials are not fully configured' });

    if (!force && this.accessToken && Date.now() < this.tokenExpiry - 30_000) return this.accessToken;

    const tokenUrl = `${this.baseUrl('authentication')}/api/token`;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    this.logger.log('Fetching new Transatel access token...');
    const startedAt = Date.now();
    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
      if (!response.ok) {
        const detail = await this.errorText(response);
        await this.record({ operation: 'token', method: 'POST', endpoint: '/authentication/api/token', status: response.status, durationMs: Date.now() - startedAt, errorCode: 'CONNECTIVITY_UNAVAILABLE', errorMessage: detail.slice(0, 2000) });
        throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Our connectivity service is temporarily unavailable. Please try again shortly.', status: 503, details: `Transatel token exchange failed with status ${response.status}: ${detail}` });
      }
      const data = (await response.json()) as TokenResponse;
      if (!data.access_token) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Our connectivity service is temporarily unavailable. Please try again shortly.', status: 503, details: 'Transatel token response did not include an access_token' });
      await this.record({ operation: 'token', method: 'POST', endpoint: '/authentication/api/token', status: 200, durationMs: Date.now() - startedAt });
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + data.expires_in * 1000;
      return this.accessToken;
    } catch (error) {
      if (error instanceof ApiException) throw error;
      this.logger.error('Transatel token request error', error);
      throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Our connectivity service is temporarily unavailable. Please try again shortly.', status: 503, details: `Transatel token request failed: ${error instanceof Error ? error.message : 'unknown error'}` });
    }
  }

  private async authorizedFetch(url: string, init: { method: string; headers?: Record<string, string>; body?: string; retryOnAuth?: boolean; operation?: string } = { method: 'GET' }): Promise<Response> {
    const { retryOnAuth = true, operation = 'unknown', ...request } = init;
    const startedAt = Date.now();
    const execute = async () => {
      const token = await this.getAccessToken();
      return fetch(url, {
        ...request,
        headers: { ...(request.headers ?? {}), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
    };
    let response = await execute();
    if (response.status === 401 && retryOnAuth) {
      this.accessToken = null;
      this.tokenExpiry = 0;
      response = await execute();
    }
    const durationMs = Date.now() - startedAt;
    let path: string;
    try { const parsed = new URL(url); path = `${parsed.pathname}${parsed.search}`; } catch { path = url; }
    if (response.ok) {
      await this.record({ operation, method: request.method, endpoint: path, status: response.status, durationMs });
    } else {
      let errorMessage: string | undefined;
      try { errorMessage = (await response.clone().text()).slice(0, 2000); } catch { /* body already consumed */ }
      await this.record({ operation, method: request.method, endpoint: path, status: response.status, durationMs, errorCode: `HTTP_${response.status}`, ...(errorMessage ? { errorMessage } : {}) });
    }
    return response;
  }

  private async record(entry: { operation: string; method: string; endpoint: string; status: number; durationMs: number; errorCode?: string; errorMessage?: string }) {
    if (!this.prisma.enabled) return;
    try {
      await this.prisma.integrationLog.create({
        data: {
          operation: entry.operation,
          method: entry.method,
          endpoint: entry.endpoint,
          status: entry.status,
          durationMs: entry.durationMs,
          ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Failed to persist integration log for ${entry.operation}`, error);
    }
  }

  private async errorText(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as ApiError;
      return data.error_description ?? data.message ?? data.error ?? JSON.stringify(data);
    } catch {
      return response.text();
    }
  }

  private subscriberIdentifier(): 'iccid' | 'msisdn' {
    return process.env.TRANSATEL_SUBSCRIBER_IDENTIFIER === 'msisdn' ? 'msisdn' : 'iccid';
  }

  /**
   * Resolves an internal reference (ICCID, order id or OCS subscription id) to the
   * subscriber identifier that Transatel uses in bind.msisdn (ICCID by default).
   */
  private async resolveSubscriber(reference: string): Promise<string> {
    if (/^\d{19,20}$/.test(reference)) return reference;

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(reference)) throw new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet. Please check back shortly.', status: 404, details: `Could not resolve Transatel subscriber for reference: ${reference}` });

    if (!this.prisma.enabled) throw new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet. Please check back shortly.', status: 404, details: `Cannot resolve Transatel subscriber in memory mode for reference: ${reference}` });

    const inventory = await this.prisma.esimInventory.findFirst({
      where: { OR: [{ assignedOrderId: reference }, { id: reference }] },
      select: { iccid: true },
    });
    if (inventory?.iccid) return inventory.iccid;

    const subscription = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: reference },
      select: { customerEsim: { select: { inventory: { select: { iccid: true } } } } },
    });
    if (subscription?.customerEsim?.inventory?.iccid) return subscription.customerEsim.inventory.iccid;

    const customerEsim = await this.prisma.customerEsim.findUnique({
      where: { orderId: reference },
      select: { inventory: { select: { iccid: true } } },
    });
    if (customerEsim?.inventory?.iccid) return customerEsim.inventory.iccid;

    throw new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet. Please check back shortly.', status: 404, details: `Could not resolve Transatel subscriber for reference: ${reference}` });
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const mvnoRef = process.env.TRANSATEL_MVNO_REF;
    if (!mvnoRef) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_CONFIGURATION, message: 'Connectivity service is not fully configured.', status: 503, details: 'TRANSATEL_MVNO_REF is not configured' });

    const plan = await this.prisma.plan.findUnique({ where: { id: request.planId } });
    if (!plan) throw new ApiException({ code: ApiErrorCode.PLAN_NOT_AVAILABLE, message: 'This plan is no longer available. Please choose another plan.', status: 404, details: `eSIM Plan not found for ID: ${request.planId}` });
    if (!plan.providerPlanId) throw new ApiException({ code: ApiErrorCode.PROVISIONING_FAILED, message: 'We could not activate your eSIM right now. Our team is reviewing it and will contact you.', status: 502, details: `eSIM Plan ${request.planId} has no provider product id` });

    const profile = await this.prisma.esimInventory.findFirst({ where: { OR: [{ assignedOrderId: request.orderId }, { eid: request.eid }] } });
    if (!profile) throw new ApiException({ code: ApiErrorCode.INVENTORY_UNAVAILABLE, message: 'No eSIM is available right now. Please try again shortly.', status: 409, details: `No allocated eSIM profile found for EID: ${request.eid}` });

    const identifier = this.subscriberIdentifier();
    const bindMsisdn = identifier === 'iccid' ? profile.iccid : profile.eid;

    const orderUrl = `${this.baseUrl('ocs/subscriptions')}/api/orders/products`;
    const payload = {
      bind: { msisdn: bindMsisdn },
      source: 'VisaCompass',
      orderType: 'preload',
      mvnoRef,
      product: { productId: plan.providerPlanId },
      ...(process.env.TRANSATEL_PAYMENT_PROVIDER ? { payment: { provider: process.env.TRANSATEL_PAYMENT_PROVIDER } } : {}),
      transactionReference: request.orderId,
    };

    this.logger.log(`Submitting OCS preload for ICCID ${profile.iccid}, product ${plan.providerPlanId}, order ${request.orderId}`);
    const response = await this.authorizedFetch(orderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), operation: 'provision' });
    if (!response.ok) {
      const detail = await this.errorText(response);
      this.logger.error(`OCS product preload failed. Status: ${response.status}, Error: ${detail}`);
      throw new ApiException({ code: ApiErrorCode.PROVISIONING_FAILED, message: 'We could not activate your eSIM right now. Our team is reviewing it and will contact you.', status: 502, details: `OCS product activation failed: ${detail}` });
    }

    const data = (await response.json()) as OrderProductResponse;
    const providerSubscriptionId = data.subscriptionId ?? data.id;
    if (!providerSubscriptionId) throw new ApiException({ code: ApiErrorCode.PROVISIONING_FAILED, message: 'We could not activate your eSIM right now. Our team is reviewing it and will contact you.', status: 502, details: 'OCS order response did not include a subscription id' });

    const details = await this.getEsimDetails(profile.iccid);
    if (details.qrPayload) {
      return { providerSubscriptionId, status: 'COMPLETED', qrPayload: details.qrPayload, ...(details.smDpAddress ? { smDpAddress: details.smDpAddress } : {}) };
    }
    return { providerSubscriptionId, status: 'DELAYED' };
  }

  async getUsage(subscriptionId: string): Promise<{ usedMb: number; totalMb: number }> {
    const subscriber = await this.resolveSubscriber(subscriptionId);
    const url = `${this.baseUrl('ocs/inventory')}/api/subscriptions/products?msisdn=${encodeURIComponent(subscriber)}&withBalances=true`;
    this.logger.log(`Fetching inventory usage for ${this.subscriberIdentifier()}: ${subscriber}`);

    const response = await this.authorizedFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, operation: 'usage' });
    if (!response.ok) throw new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet. Please check back shortly.', status: 502, details: `Failed to fetch usage balance from Transatel: ${await this.errorText(response)}` });

    const data = (await response.json()) as ProductSubscriptionsResponse;
    const subscriptions = data.productSubscriptions.filter((item) => item.status !== 'terminated');
    if (!subscriptions.length) throw new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet. Please check back shortly.', status: 404, details: 'No active subscription found for this subscriber' });

    const usage = subscriptions.map((item) => this.usageFromBalances(item.balances)).filter((item): item is { usedMb: number; totalMb: number } => Boolean(item));
    if (!usage.length) return { usedMb: 0, totalMb: 0 };
    return usage.reduce((acc, item) => ({ usedMb: acc.usedMb + item.usedMb, totalMb: acc.totalMb + item.totalMb }), { usedMb: 0, totalMb: 0 });
  }

  private usageFromBalances(balances?: ProductSubscription['balances']): { usedMb: number; totalMb: number } | null {
    const entries: ScpBalance[] = Array.isArray(balances?.data) ? balances!.data! : [];
    const dataResources = entries.filter((entry) => entry.resourceUnit === 'KB');
    if (!dataResources.length) return null;
    const start = Math.max(...dataResources.map((entry) => Number(entry.resourceStartValue) > 0 ? Number(entry.resourceStartValue) : 0), 0);
    const remaining = Math.max(...dataResources.map((entry) => Number(entry.resourceValue) >= 0 ? Number(entry.resourceValue) : 0), 0);
    const unlimited = dataResources.some((entry) => Number(entry.resourceValue) === -1);
    const totalMb = Math.max(1, Math.round(start / 1024));
    const remainingMb = unlimited ? totalMb : Math.min(totalMb, Math.round(remaining / 1024));
    return { usedMb: Math.max(0, totalMb - remainingMb), totalMb };
  }

  async getEsimDetails(subscriptionId: string): Promise<EsimDetailsResult> {
    const subscriber = await this.resolveSubscriber(subscriptionId);
    const url = `${this.baseUrl('sim-management/sims')}/api/esims/sim-serial/${encodeURIComponent(subscriber)}`;
    this.logger.log(`Fetching eSIM details for ICCID: ${subscriber}`);

    const response = await this.authorizedFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, operation: 'esim-details' });
    if (!response.ok) throw new ApiException({ code: ApiErrorCode.USAGE_UNAVAILABLE, message: 'Usage details are not available yet. Please check back shortly.', status: 502, details: `Failed to query eSIM details from Transatel: ${await this.errorText(response)}` });

    const data = (await response.json()) as ESimDetailsResponse;
    return {
      subscriptionId: subscriber,
      status: data.status,
      ...(data.smdpAddress ? { smDpAddress: data.smdpAddress } : {}),
      ...(data.qrCode?.value || data.activationCode ? { qrPayload: data.qrCode?.value ?? data.activationCode } : {}),
    };
  }

  async syncCatalog(): Promise<CatalogSyncResult> {
    if (!this.prisma.enabled) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Catalog synchronization is unavailable right now.', status: 503, details: 'Catalog sync requires database persistence' });
    const cos = process.env.TRANSATEL_COS || 'WW_COS_UBG_MKP_EUR';
    const url = `${this.baseUrl('ocs/catalog')}/api/cos/${encodeURIComponent(cos)}/products?availabilityStatus=AVAILABLE&categories=One-off`;
    this.logger.log(`Synchronizing Transatel catalog for COS: ${cos}`);

    const response = await this.authorizedFetch(url, { method: 'GET', headers: { Accept: 'application/json', 'Accept-Language': 'en_US' }, operation: 'catalog' });
    if (!response.ok) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Catalog synchronization is unavailable right now.', status: 502, details: `Transatel catalog fetch failed: ${await this.errorText(response)}` });

    const data = (await response.json()) as ProductCatalogResponse;
    let synced = 0;
    const skipped: string[] = [];

    for (const product of data.products) {
      const definition = product.productDefinition;
      const countries = (definition.countryList ?? []).map((iso3) => this.iso3ToIso2(iso3)).filter((iso2): iso2 is string => Boolean(iso2));
      if (!definition.productId || !countries.length) {
        skipped.push(definition.productId ?? 'unknown-product');
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
      const name = names?.productLabel || names?.productShortText || definition.productId;

      try {
        await this.prisma.$transaction(async (tx) => {
          for (const isoCode of countries) {
            const country = await tx.country.upsert({
              where: { isoCode },
              update: { name: this.countryName(isoCode), active: true },
              create: { isoCode, name: this.countryName(isoCode) },
            });
            await tx.plan.upsert({
              where: { countryId_providerPlanId: { countryId: country.id, providerPlanId: definition.productId } },
              update: {
                name,
                dataAllowance: allowanceMb !== null ? `${allowanceMb} MB` : 'Unlimited',
                validityDays,
                costPrice: price,
                sellingPrice: price,
                coverage: definition.countryList ?? [],
                popular: false,
                status: 'ACTIVE',
              },
              create: {
                countryId: country.id,
                providerPlanId: definition.productId,
                name,
                dataAllowance: allowanceMb !== null ? `${allowanceMb} MB` : 'Unlimited',
                validityDays,
                costPrice: price,
                sellingPrice: price,
                coverage: definition.countryList ?? [],
                popular: false,
                status: 'ACTIVE',
              },
            });
          }
        });
        synced += countries.length;
      } catch (error) {
        this.logger.error(`Failed to sync Transatel product ${definition.productId}: ${error instanceof Error ? error.message : 'unknown'}`);
        skipped.push(definition.productId);
      }
    }

    this.logger.log(`Transatel catalog sync finished: ${synced} plan(s) synced, ${skipped.length} skipped`);
    return { synced, skipped: skipped.length };
  }

  async checkEligibility(planId: string, msisdn: string): Promise<EligibilityResult> {
    if (!this.prisma.enabled) return { allowed: true };
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan?.providerPlanId) throw new ApiException({ code: ApiErrorCode.PLAN_NOT_AVAILABLE, message: 'This plan is no longer available. Please choose another plan.', status: 404, details: 'Plan not found or has no provider product id' });
    const cos = process.env.TRANSATEL_COS || 'WW_COS_UBG_MKP_EUR';
    const url = `${this.baseUrl('ocs/catalog')}/api/cos/${encodeURIComponent(cos)}/products/${encodeURIComponent(plan.providerPlanId)}?msisdn=${encodeURIComponent(msisdn)}`;

    const response = await this.authorizedFetch(url, { method: 'GET', headers: { Accept: 'application/json', 'Accept-Language': 'en_US' }, operation: 'eligibility' });
    if (!response.ok) {
      const detail = await this.errorText(response);
      if (response.status === 403 || response.status === 404) {
        return { allowed: false, errorKey: 'ELIGIBILITY_REJECTED', errorMessage: 'This eSIM is not available for the number you provided. Please check and try again.' };
      }
      throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Our connectivity service is temporarily unavailable. Please try again shortly.', status: 502, details: `Transatel eligibility check failed: ${detail}` });
    }
    const data = (await response.json()) as ProductDetails;
    return { allowed: Boolean(data.canSubscribe?.allowed), ...(data.canSubscribe?.errorKey ? { errorKey: data.canSubscribe.errorKey } : {}), ...(data.canSubscribe?.errorMessage ? { errorMessage: data.canSubscribe.errorMessage } : {}) };
  }

  async ensureWebhook(): Promise<{ registered: boolean; id?: string; targetUrl: string; events: string[] }> {
    const targetUrl = process.env.TRANSATEL_WEBHOOK_TARGET_URL;
    if (!targetUrl) return { registered: false, targetUrl: '', events: [] };
    const mvnoRef = this.env('TRANSATEL_MVNO_REF');
    const email = process.env.TRANSATEL_WEBHOOK_CONTACT_EMAIL ?? 'it-operations@visacompass.local';
    const secret = process.env.TRANSATEL_WEBHOOK_SECRET ?? '';
    const events = (process.env.TRANSATEL_WEBHOOK_EVENTS ?? 'OCS/PRODUCT/PRELOADED,OCS/PRODUCT/ACTIVATED,OCS/PRODUCT/EXPIRED,OCS/PRODUCT/TERMINATED')
      .split(',').map((item) => item.trim()).filter(Boolean);

    const base = this.baseUrl('webhooks');
    const listResponse = await this.authorizedFetch(`${base}/api/webhooks`, { method: 'GET', operation: 'webhook' });
    if (!listResponse.ok) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Webhook registration is unavailable right now.', status: 502, details: `Failed to list Transatel webhooks: ${await this.errorText(listResponse)}` });
    const listed = (await listResponse.json()) as WebhooksResponse;
    const existing = (Array.isArray(listed.webhooks) ? listed.webhooks : []).find((item) => item.targetUrl === targetUrl && item.mvnoRef === mvnoRef);

    const definition = { mvnoRef, status: 'active', targetUrl, email, ...(secret ? { secret } : {}), events };
    let id: string | undefined;
    if (existing) {
      const updateResponse = await this.authorizedFetch(`${base}/api/webhooks/${existing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definition), operation: 'webhook' });
      if (!updateResponse.ok) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Webhook registration is unavailable right now.', status: 502, details: `Failed to update Transatel webhook: ${await this.errorText(updateResponse)}` });
      id = existing.id;
      this.logger.log(`Updated Transatel webhook ${id} for ${targetUrl}`);
    } else {
      const createResponse = await this.authorizedFetch(`${base}/api/webhooks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definition), operation: 'webhook' });
      if (!createResponse.ok) throw new ApiException({ code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE, message: 'Webhook registration is unavailable right now.', status: 502, details: `Failed to register Transatel webhook: ${await this.errorText(createResponse)}` });
      id = ((await createResponse.json()) as WebhookResponse).id;
      this.logger.log(`Registered Transatel webhook ${id} for ${targetUrl}`);
    }
    return { registered: true, id, targetUrl, events };
  }

  async handleWebhook(payload: unknown): Promise<ProviderWebhookResult> {
    const envelope = this.normalizeEnvelope(payload);
    const eventType = envelope.eventType;
    if (!eventType) return { handled: false, reason: 'Webhook payload is missing header.eventType' };

    const iccid = envelope.iccid;
    if (!iccid) return { handled: false, reason: `Webhook ${eventType} did not carry a subscriber identifier` };

    let orderId: string | undefined;
    if (this.prisma.enabled) {
      const inventory = await this.prisma.esimInventory.findUnique({ where: { iccid }, select: { assignedOrderId: true } });
      orderId = inventory?.assignedOrderId ?? undefined;
    }
    if (!orderId) return { handled: false, reason: `No allocated inventory profile found for ICCID ${iccid} (event ${eventType})` };

    const eventStatus = this.mapEventType(eventType);
    const event: ProviderWebhookEvent = {
      eventType,
      orderId,
      iccid,
      ...(envelope.subscriptionId ? { subscriptionId: envelope.subscriptionId } : {}),
      ...(eventStatus ? { status: eventStatus } : {}),
      ...(envelope.activatedAt ? { activatedAt: envelope.activatedAt } : {}),
      ...(envelope.expiresAt ? { expiresAt: envelope.expiresAt } : {}),
    };

    if (event.status === 'ACTIVATED' && this.prisma.enabled) {
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
      if (order && order.status !== 'COMPLETED') {
        try {
          const details = await this.getEsimDetails(iccid);
          if (details.qrPayload) event.qrPayload = details.qrPayload;
        } catch (error) {
          this.logger.warn(`Could not enrich QR payload during ${eventType} for ICCID ${iccid}: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
    }

    return { handled: true, event };
  }

  private normalizeEnvelope(payload: unknown): { eventType?: string; iccid?: string; subscriptionId?: string; activatedAt?: string; expiresAt?: string } {
    const body = (payload as { header?: Record<string, unknown>; body?: Record<string, unknown> }) ?? {};
    const header = body.header ?? {};
    const data = body.body ?? (typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {});

    const eventType = String(header.eventType ?? data.eventType ?? '');

    const bind = (data.bind ?? {}) as Record<string, unknown>;
    const product = (data.product ?? {}) as Record<string, unknown>;
    const subscription = (data.subscription ?? {}) as Record<string, unknown>;
    const serialNumbers = Array.isArray(product.serialNumbers) ? (product.serialNumbers as unknown[]) : [];
    const subscriptionSerialNumbers = Array.isArray(subscription.serialNumbers) ? (subscription.serialNumbers as unknown[]) : [];

    const iccid =
      (typeof data.iccid === 'string' ? data.iccid : undefined) ??
      (this.subscriberIdentifier() === 'iccid' && typeof data.msisdn === 'string' && /^\d{19,20}$/.test(data.msisdn) ? data.msisdn : undefined) ??
      (this.subscriberIdentifier() === 'iccid' ? bind.msisdn : undefined) ??
      (typeof bind.msisdn === 'string' && /^\d{19,20}$/.test(String(bind.msisdn)) ? bind.msisdn : undefined) ??
      (typeof subscription.iccid === 'string' ? subscription.iccid : undefined) ??
      (typeof product.iccid === 'string' ? product.iccid : undefined) ??
      (typeof serialNumbers[0] === 'string' ? serialNumbers[0] : undefined) ??
      (typeof subscriptionSerialNumbers[0] === 'string' ? subscriptionSerialNumbers[0] : undefined);

    const activatedAt = typeof data.activatedAt === 'string' ? data.activatedAt : typeof data.activationDate === 'string' ? data.activationDate : undefined;
    const expiresAt = typeof data.expiresAt === 'string' ? data.expiresAt : typeof data.expirationDate === 'string' ? data.expirationDate : undefined;

    return {
      eventType,
      ...(iccid ? { iccid: String(iccid) } : {}),
      ...(typeof data.subscriptionId === 'string' ? { subscriptionId: data.subscriptionId } : {}),
      ...(activatedAt ? { activatedAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  private mapEventType(eventType: string): ProviderWebhookEvent['status'] {
    const normalized = eventType.toUpperCase();
    if (normalized.endsWith('ACTIVATED')) return 'ACTIVATED';
    if (normalized.endsWith('PRELOADED')) return 'PRELOADED';
    if (normalized.endsWith('EXPIRED')) return 'EXPIRED';
    if (normalized.endsWith('TERMINATED')) return 'TERMINATED';
    if (normalized.endsWith('CANCELED') || normalized.endsWith('CANCELLED')) return 'CANCELED';
    return 'OTHER';
  }

  private validityDays(validity?: ProductDetails['productDefinition']['validityPeriod']): number {
    if (!validity?.validityDuration) return 0;
    const multiplier = validity.validityDurationUnit === 'months' ? 30 : 1;
    return Math.max(1, validity.validityDuration * multiplier);
  }

  private allowanceMb(allowances: unknown): number | null {
    const data = this.allowanceEntries(allowances);
    if (!data.length) return null;
    const main = data.find((entry) => String(entry.resourceName ?? '').toUpperCase() === 'DATA') ?? data[0];
    if (!main) return null;
    const value = Number(main.startValue);
    if (!Number.isFinite(value)) return null;
    const unit = String(main.unit ?? 'MB').toUpperCase();
    if (unit === 'GB') return Math.round(value * 1024);
    if (unit === 'KB') return Math.max(1, Math.round(value / 1024));
    return Math.round(value);
  }

  private allowanceEntries(allowances: unknown): Array<{ resourceName?: string; startValue?: number | string; unit?: string }> {
    if (!allowances || typeof allowances !== 'object') return [];
    const candidate = allowances as { data?: unknown; entries?: unknown };
    const list = Array.isArray(candidate.data) ? candidate.data : Array.isArray(candidate.entries) ? candidate.entries : null;
    return (list ?? []).map((entry) => (typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {})).map((entry) => ({
      ...(typeof entry.resourceName === 'string' ? { resourceName: entry.resourceName } : typeof entry.name === 'string' ? { resourceName: entry.name } : {}),
      ...(typeof entry.startValue === 'number' || typeof entry.startValue === 'string' ? { startValue: entry.startValue } : typeof entry.value === 'number' ? { startValue: entry.value } : {}),
      ...(typeof entry.unit === 'string' ? { unit: entry.unit } : {}),
    }));
  }

  private priceNpr(fee?: Price[][]): number | null {
    if (!Array.isArray(fee) || !fee.length) return null;
    const first = Array.isArray(fee[0]) ? fee[0][0] : undefined;
    if (!first) return null;
    const amount = Number(first.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const fx = Number(process.env.TRANSATEL_FX_TO_NPR);
    if (!Number.isFinite(fx) || fx <= 0) return null;
    const minor = /^(CENT|CENTS)$/i.test(String(first.unit ?? ''));
    const value = minor ? amount / 100 : amount;
    return Math.max(1, Math.round(value * fx));
  }

  private iso3ToIso2(iso3: string): string | undefined {
    return ISO3_TO_ISO2[iso3.toUpperCase()];
  }

  private countryName(iso2: string): string {
    return ISO2_NAMES[iso2] ?? iso2;
  }
}

const ISO3_TO_ISO2: Record<string, string> = {
  AFG: 'AF', ALB: 'AL', DZA: 'DZ', ASM: 'AS', AND: 'AD', AGO: 'AO', ATG: 'AG', ARG: 'AR', ARM: 'AM', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BHS: 'BS', BHR: 'BH', BGD: 'BD', BRB: 'BB', BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ', BTN: 'BT', BOL: 'BO', BIH: 'BA', BWA: 'BW', BRA: 'BR', BRN: 'BN', BGR: 'BG', BFA: 'BF', BDI: 'BI', KHM: 'KH', CMR: 'CM', CAN: 'CA', CPV: 'CV', CAF: 'CF', TCD: 'TD', CHL: 'CL', CHN: 'CN', COL: 'CO', COM: 'KM', COG: 'CG', COD: 'CD', CRI: 'CR', CIV: 'CI', HRV: 'HR', CUB: 'CU', CYP: 'CY', CZE: 'CZ', DNK: 'DK', DJI: 'DJ', DMA: 'DM', DOM: 'DO', ECU: 'EC', EGY: 'EG', SLV: 'SV', GNQ: 'GQ', ERI: 'ER', EST: 'EE', SWZ: 'SZ', ETH: 'ET', FJI: 'FJ', FIN: 'FI', FRA: 'FR', GAB: 'GA', GMB: 'GM', GEO: 'GE', DEU: 'DE', GHA: 'GH', GRC: 'GR', GRD: 'GD', GTM: 'GT', GIN: 'GN', GNB: 'GW', GUY: 'GY', HTI: 'HT', HND: 'HN', HUN: 'HU', ISL: 'IS', IND: 'IN', IDN: 'ID', IRN: 'IR', IRQ: 'IQ', IRL: 'IE', ISR: 'IL', ITA: 'IT', JAM: 'JM', JPN: 'JP', JOR: 'JO', KAZ: 'KZ', KEN: 'KE', KIR: 'KI', PRK: 'KP', KOR: 'KR', KWT: 'KW', KGZ: 'KG', LAO: 'LA', LVA: 'LV', LBN: 'LB', LSO: 'LS', LBR: 'LR', LBY: 'LY', LIE: 'LI', LTU: 'LT', LUX: 'LU', MDG: 'MG', MWI: 'MW', MYS: 'MY', MDV: 'MV', MLI: 'ML', MLT: 'MT', MHL: 'MH', MRT: 'MR', MUS: 'MU', MEX: 'MX', FSM: 'FM', MDA: 'MD', MCO: 'MC', MNG: 'MN', MNE: 'ME', MAR: 'MA', MOZ: 'MZ', MMR: 'MM', NAM: 'NA', NRU: 'NR', NPL: 'NP', NLD: 'NL', NZL: 'NZ', NIC: 'NI', NER: 'NE', NGA: 'NG', MKD: 'MK', NOR: 'NO', OMN: 'OM', PAK: 'PK', PLW: 'PW', PAN: 'PA', PNG: 'PG', PRY: 'PY', PER: 'PE', PHL: 'PH', POL: 'PL', PRT: 'PT', QAT: 'QA', ROU: 'RO', RUS: 'RU', RWA: 'RW', KNA: 'KN', LCA: 'LC', VCT: 'VC', WSM: 'WS', SMR: 'SM', STP: 'ST', SAU: 'SA', SEN: 'SN', SRB: 'RS', SYC: 'SC', SLE: 'SL', SGP: 'SG', SVK: 'SK', SVN: 'SI', SLB: 'SB', SOM: 'SO', ZAF: 'ZA', SSD: 'SS', ESP: 'ES', LKA: 'LK', SDN: 'SD', SUR: 'SR', SWE: 'SE', CHE: 'CH', SYR: 'SY', TWN: 'TW', TJK: 'TJ', TZA: 'TZ', THA: 'TH', TLS: 'TL', TGO: 'TG', TON: 'TO', TTO: 'TT', TUN: 'TN', TUR: 'TR', TKM: 'TM', TUV: 'TV', UGA: 'UG', UKR: 'UA', ARE: 'AE', GBR: 'GB', USA: 'US', URY: 'UY', UZB: 'UZ', VUT: 'VU', VAT: 'VA', VEN: 'VE', VNM: 'VN', YEM: 'YE', ZMB: 'ZM', ZWE: 'ZW',
};

const ISO2_NAMES: Record<string, string> = {
  AF: 'Afghanistan', AL: 'Albania', DZ: 'Algeria', AD: 'Andorra', AO: 'Angola', AG: 'Antigua and Barbuda', AR: 'Argentina', AM: 'Armenia', AU: 'Australia', AT: 'Austria', AZ: 'Azerbaijan', BS: 'Bahamas', BH: 'Bahrain', BD: 'Bangladesh', BB: 'Barbados', BY: 'Belarus', BE: 'Belgium', BZ: 'Belize', BJ: 'Benin', BT: 'Bhutan', BO: 'Bolivia', BA: 'Bosnia and Herzegovina', BW: 'Botswana', BR: 'Brazil', BN: 'Brunei', BG: 'Bulgaria', BF: 'Burkina Faso', BI: 'Burundi', CV: 'Cape Verde', KH: 'Cambodia', CM: 'Cameroon', CA: 'Canada', CF: 'Central African Republic', TD: 'Chad', CL: 'Chile', CN: 'China', CO: 'Colombia', KM: 'Comoros', CG: 'Congo', CR: 'Costa Rica', HR: 'Croatia', CU: 'Cuba', CY: 'Cyprus', CZ: 'Czechia', DK: 'Denmark', DJ: 'Djibouti', DM: 'Dominica', DO: 'Dominican Republic', EC: 'Ecuador', EG: 'Egypt', SV: 'El Salvador', GQ: 'Equatorial Guinea', ER: 'Eritrea', EE: 'Estonia', SZ: 'Eswatini', ET: 'Ethiopia', FJ: 'Fiji', FI: 'Finland', FR: 'France', GA: 'Gabon', GM: 'Gambia', GE: 'Georgia', DE: 'Germany', GH: 'Ghana', GR: 'Greece', GD: 'Grenada', GT: 'Guatemala', GN: 'Guinea', GW: 'Guinea-Bissau', GY: 'Guyana', HT: 'Haiti', HN: 'Honduras', HU: 'Hungary', IS: 'Iceland', IN: 'India', ID: 'Indonesia', IR: 'Iran', IQ: 'Iraq', IE: 'Ireland', IL: 'Israel', IT: 'Italy', JM: 'Jamaica', JP: 'Japan', JO: 'Jordan', KZ: 'Kazakhstan', KE: 'Kenya', KI: 'Kiribati', KR: 'South Korea', KW: 'Kuwait', KG: 'Kyrgyzstan', LA: 'Laos', LV: 'Latvia', LB: 'Lebanon', LS: 'Lesotho', LR: 'Liberia', LY: 'Libya', LI: 'Liechtenstein', LT: 'Lithuania', LU: 'Luxembourg', MG: 'Madagascar', MW: 'Malawi', MY: 'Malaysia', MV: 'Maldives', ML: 'Mali', MT: 'Malta', MH: 'Marshall Islands', MR: 'Mauritania', MU: 'Mauritius', MX: 'Mexico', FM: 'Micronesia', MD: 'Moldova', MC: 'Monaco', MN: 'Mongolia', ME: 'Montenegro', MA: 'Morocco', MZ: 'Mozambique', MM: 'Myanmar', NA: 'Namibia', NR: 'Nauru', NP: 'Nepal', NL: 'Netherlands', NZ: 'New Zealand', NI: 'Nicaragua', NE: 'Niger', NG: 'Nigeria', MK: 'North Macedonia', NO: 'Norway', OM: 'Oman', PK: 'Pakistan', PW: 'Palau', PA: 'Panama', PG: 'Papua New Guinea', PY: 'Paraguay', PE: 'Peru', PH: 'Philippines', PL: 'Poland', PT: 'Portugal', QA: 'Qatar', RO: 'Romania', RU: 'Russia', RW: 'Rwanda', KN: 'Saint Kitts and Nevis', LC: 'Saint Lucia', VC: 'Saint Vincent and the Grenadines', WS: 'Samoa', SM: 'San Marino', ST: 'Sao Tome and Principe', SA: 'Saudi Arabia', SN: 'Senegal', RS: 'Serbia', SC: 'Seychelles', SL: 'Sierra Leone', SG: 'Singapore', SK: 'Slovakia', SI: 'Slovenia', SB: 'Solomon Islands', SO: 'Somalia', ZA: 'South Africa', SS: 'South Sudan', ES: 'Spain', LK: 'Sri Lanka', SD: 'Sudan', SR: 'Suriname', SE: 'Sweden', CH: 'Switzerland', SY: 'Syria', TW: 'Taiwan', TJ: 'Tajikistan', TZ: 'Tanzania', TH: 'Thailand', TL: 'Timor-Leste', TG: 'Togo', TO: 'Tonga', TT: 'Trinidad and Tobago', TN: 'Tunisia', TR: 'Türkiye', TM: 'Turkmenistan', TV: 'Tuvalu', UG: 'Uganda', UA: 'Ukraine', AE: 'United Arab Emirates', GB: 'United Kingdom', US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VU: 'Vanuatu', VA: 'Vatican City', VE: 'Venezuela', VN: 'Vietnam', YE: 'Yemen', ZM: 'Zambia', ZW: 'Zimbabwe',
};
