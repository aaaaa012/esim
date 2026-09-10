import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHmac } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";

export type UsageFreshness = "FRESH" | "STALE";
export type UsageCompleteness = "FULL" | "PARTIAL";
export type UsageStatus = "AVAILABLE" | "WAITING_FOR_FIRST_USE" | "UNAVAILABLE";

export type UsagePackage = {
  id: string;
  packageReference: string;
  orderId: string;
  orderNumber: string;
  externalOrderId: string | null;
  partnerId: string | null;
  purchaseType: string;
  channel: string;
  plan: {
    id: string;
    name: string;
    countryCode: string;
    countryName: string;
    dataAllowance: string;
    validityDays: number;
  };
  subscriptionId: string;
  providerSubscriptionId: string;
  status: string;
  balanceStatus:
    "CONFIRMED" | "LAST_KNOWN" | "WAITING_FOR_FIRST_USE" | "UNAVAILABLE";
  usedMb: number;
  totalMb: number;
  remainingMb: number;
  activatedAt: string | null;
  expiresAt: string | null;
  lastConfirmedAt: string | null;
  lastCheckedAt: string | null;
  verificationStatus: string;
  assignmentVerificationStatus: string;
};

export type EsimUsageView = {
  esim: {
    id: string;
    iccid: string;
    msisdn: string | null;
    status: string;
  };
  usageStatus: UsageStatus;
  completeness: UsageCompleteness;
  freshness: UsageFreshness;
  lastConfirmedAt: string | null;
  oldestConfirmedAt: string | null;
  summary: {
    usedMb: number;
    totalMb: number;
    remainingMb: number;
    confirmedPackageCount: number;
    unconfirmedPackageCount: number;
    packageCount: number;
  };
  packages: UsagePackage[];
};

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly resilience: ProductionResilienceService,
  ) {}

  async forOrder(orderId: string) {
    const link = await this.prisma.customerEsim.findUnique({
      where: { orderId },
      select: { inventoryId: true },
    });
    if (!link) return null;
    return this.cached(link.inventoryId);
  }

  async cached(inventoryId: string): Promise<EsimUsageView> {
    const row = await this.load(inventoryId);
    return this.toView(row);
  }

  viewFromInventory(row: unknown): EsimUsageView {
    return this.toView(row as any);
  }

  async refresh(inventoryId: string): Promise<EsimUsageView> {
    const row = await this.load(inventoryId);
    const usage = await this.connectivity.getUsage(row.iccid);
    if (usage.usageAvailable === false && !usage.subscriptions?.length)
      throw new BadRequestException(
        "Transatel found the eSIM but did not return a usable data balance",
      );

    // A newly subscribed Transatel package may temporarily be present as 0/0.
    // Keep explicit no-balance inventory evidence; reject unusable legacy balances.
    const balances = new Map(
      (usage.subscriptions ?? [])
        .filter(
          (item) =>
            item.usageAvailable === false ||
            (Number.isFinite(item.totalMb) &&
              item.totalMb > 0 &&
              Number.isFinite(item.usedMb) &&
              item.usedMb >= 0),
        )
        .map((item) => [item.providerSubscriptionId, item]),
    );
    const local = row.customerEsims.flatMap((link: any) =>
      link.subscriptions.map((subscription: any) => ({
        ...subscription,
        orderId: link.orderId,
        assignedAt: link.assignedAt,
      })),
    );
    const eligible = local.filter((subscription: any) =>
      ["ACTIVE", "PENDING"].includes(subscription.status),
    );
    if (!usage.subscriptions && eligible.length === 1)
      balances.set(eligible[0].providerSubscriptionId, {
        providerSubscriptionId: eligible[0].providerSubscriptionId,
        status: eligible[0].status,
        usedMb: usage.usedMb,
        totalMb: usage.totalMb,
        priority: 1,
      });
    const checkedAt = new Date();
    const matchedProviderIds = new Set<string>();

    await this.prisma.$transaction(
      eligible.map((subscription: any) => {
        const balance = balances.get(subscription.providerSubscriptionId);
        if (!balance) {
          if (this.awaitingBalancePublication(subscription, checkedAt))
            return this.prisma.subscription.update({
              where: { id: subscription.id },
              data: { assignmentVerificationStatus: "PENDING" },
            });
          return this.prisma.subscription.update({
            where: { id: subscription.id },
            data: { assignmentVerificationStatus: "MISMATCH" },
          });
        }
        matchedProviderIds.add(subscription.providerSubscriptionId);
        return this.prisma.subscription.update({
          where: { id: subscription.id },
          data: {
            ...(balance.usageAvailable === false
              ? {}
              : {
                  usedMb: balance.usedMb,
                  totalMb: balance.totalMb,
                  usageLastCheckedAt: checkedAt,
                }),
            ...(["readyForUse", "pendingForFirstUse", "scheduled"].includes(
              balance.status,
            )
              ? {
                  status: "PENDING",
                  activatedAt: null,
                  expiresAt: null,
                  usageLastCheckedAt: null,
                }
              : balance.status === "active"
                ? {
                    status: "ACTIVE",
                    ...(balance.activatedAt
                      ? { activatedAt: new Date(balance.activatedAt) }
                      : {}),
                    ...(balance.expiresAt
                      ? { expiresAt: new Date(balance.expiresAt) }
                      : {}),
                  }
                : balance.status === "suspended"
                  ? { status: "SUSPENDED" }
                  : balance.status === "expired"
                    ? { status: "EXPIRED" }
                    : balance.status === "terminated"
                      ? { status: "TERMINATED" }
                      : {}),
            providerLastSeenAt: checkedAt,
            assignmentVerificationStatus: "VERIFIED",
            assignmentVerifiedAt:
              subscription.assignmentVerifiedAt ?? checkedAt,
          },
        });
      }),
    );

    await Promise.allSettled(
      eligible.map(async (subscription: any) => {
        const key = `subscription-assignment:${subscription.id}`;
        if (balances.has(subscription.providerSubscriptionId))
          return this.resilience.resolve(
            key,
            null,
            "Provider inventory confirms the assigned subscription",
          );
        if (this.awaitingBalancePublication(subscription, checkedAt)) return;
        return this.resilience.attention({
          dedupeKey: key,
          category: "SUBSCRIPTION_ASSIGNMENT_CONFLICT",
          entityType: "Subscription",
          entityId: subscription.id,
          orderId: subscription.orderId,
          severity: "CRITICAL",
          summary: "Provider subscription is missing from its assigned eSIM",
          detail:
            "The last-known balance was preserved and excluded from confirmed totals.",
          localState: subscription.status,
          externalState: "SUBSCRIPTION_NOT_FOUND_ON_ICCID",
          lastSuccessfulStep: "ESIM_ASSIGNED",
          failureCategory: "PROVIDER_ASSIGNMENT_MISMATCH",
          availableActions: ["RECHECK_ORDER_PROVIDER"],
        });
      }),
    );

    const unknown = [...balances.keys()].filter(
      (providerId) => !matchedProviderIds.has(providerId),
    );
    await Promise.allSettled(
      unknown.map((providerId) =>
        this.resilience.attention({
          dedupeKey: `usage-provider-subscription:${inventoryId}:${this.reference(providerId)}`,
          category: "SUBSCRIPTION_ASSIGNMENT_CONFLICT",
          entityType: "EsimInventory",
          entityId: inventoryId,
          severity: "CRITICAL",
          summary: "Provider returned an unknown subscription for this eSIM",
          detail:
            "The unknown balance was excluded from totals until its order identity is reconciled.",
          externalState: "UNKNOWN_PROVIDER_SUBSCRIPTION",
          lastSuccessfulStep: "USAGE_FETCHED",
          failureCategory: "PROVIDER_ASSIGNMENT_MISMATCH",
          availableActions: ["RECHECK_ORDER_PROVIDER"],
        }),
      ),
    );

    const refreshed = await this.cached(inventoryId);
    if (!unknown.length) return refreshed;
    return {
      ...refreshed,
      completeness: "PARTIAL",
      summary: {
        ...refreshed.summary,
        unconfirmedPackageCount:
          refreshed.summary.unconfirmedPackageCount + unknown.length,
        packageCount: refreshed.summary.packageCount + unknown.length,
      },
    };
  }

  packageForOrder(view: EsimUsageView, orderId: string) {
    return view.packages.find((item) => item.orderId === orderId) ?? null;
  }

  externalReference(providerSubscriptionId: string) {
    return this.reference(providerSubscriptionId);
  }

  private async load(inventoryId: string): Promise<any> {
    const row = await this.prisma.esimInventory.findUnique({
      where: { id: inventoryId },
      include: {
        customerEsims: {
          include: {
            order: { include: { plan: { include: { country: true } } } },
            subscriptions: true,
          },
          orderBy: { assignedAt: "asc" },
        },
      },
    });
    if (!row)
      throw new NotFoundException({
        code: "ESIM_NOT_FOUND",
        message: "eSIM not found",
      });
    return row;
  }

  private toView(row: any): EsimUsageView {
    const now = Date.now();
    const freshnessMs =
      Math.max(1, Number(process.env.RECONCILIATION_INTERVAL_MINUTES ?? 15)) *
      60_000;
    const packages: UsagePackage[] = row.customerEsims.flatMap((link: any) =>
      link.subscriptions.map((subscription: any) => {
        const eligible = ["ACTIVE", "PENDING"].includes(subscription.status);
        const confirmed =
          eligible &&
          subscription.assignmentVerificationStatus === "VERIFIED" &&
          Boolean(subscription.usageLastCheckedAt);
        const lastKnown =
          eligible &&
          subscription.assignmentVerificationStatus === "MISMATCH" &&
          Boolean(subscription.usageLastCheckedAt);
        return {
          id: subscription.id,
          packageReference: this.reference(subscription.providerSubscriptionId),
          orderId: link.order.id,
          orderNumber: link.order.orderNumber,
          externalOrderId: link.order.externalOrderId,
          partnerId: link.order.partnerId,
          purchaseType: link.order.orderType,
          channel: link.order.channel,
          plan: {
            id: link.order.plan.id,
            name: link.order.plan.name,
            countryCode: link.order.plan.country.isoCode,
            countryName: link.order.plan.country.name,
            dataAllowance: link.order.plan.dataAllowance,
            validityDays: link.order.plan.validityDays,
          },
          subscriptionId: subscription.id,
          providerSubscriptionId: subscription.providerSubscriptionId,
          status: subscription.status,
          balanceStatus: confirmed
            ? "CONFIRMED"
            : lastKnown
              ? "LAST_KNOWN"
              : subscription.assignmentVerificationStatus === "PENDING" ||
                  (subscription.status === "PENDING" &&
                    subscription.assignmentVerificationStatus === "VERIFIED")
                ? "WAITING_FOR_FIRST_USE"
                : "UNAVAILABLE",
          usedMb: subscription.usedMb,
          totalMb: subscription.totalMb,
          remainingMb: Math.max(0, subscription.totalMb - subscription.usedMb),
          activatedAt: subscription.activatedAt?.toISOString() ?? null,
          expiresAt: subscription.activatedAt
            ? (subscription.expiresAt?.toISOString() ?? null)
            : null,
          lastConfirmedAt:
            subscription.usageLastCheckedAt?.toISOString() ?? null,
          lastCheckedAt: subscription.usageLastCheckedAt?.toISOString() ?? null,
          verificationStatus: subscription.assignmentVerificationStatus,
          assignmentVerificationStatus:
            subscription.assignmentVerificationStatus,
        } satisfies UsagePackage;
      }),
    );
    const eligible = packages.filter((item) =>
      ["ACTIVE", "PENDING"].includes(item.status),
    );
    const confirmed = eligible.filter(
      (item) => item.balanceStatus === "CONFIRMED",
    );
    const timestamps = confirmed
      .map((item) => item.lastConfirmedAt)
      .filter((item): item is string => Boolean(item))
      .sort();
    const totals = confirmed.reduce(
      (total, item) => ({
        usedMb: total.usedMb + item.usedMb,
        totalMb: total.totalMb + item.totalMb,
        remainingMb: total.remainingMb + item.remainingMb,
      }),
      {
        usedMb: 0,
        totalMb: 0,
        remainingMb: 0,
      },
    );
    const summary = {
      ...totals,
      confirmedPackageCount: confirmed.length,
      unconfirmedPackageCount: eligible.length - confirmed.length,
      packageCount: eligible.length,
    };
    const oldest = timestamps[0] ?? null;
    return {
      esim: {
        id: row.id,
        iccid: row.iccid,
        msisdn: row.msisdn,
        status: row.status,
      },
      usageStatus: confirmed.length
        ? "AVAILABLE"
        : eligible.some(
              (item) =>
                item.status === "PENDING" &&
                item.verificationStatus !== "MISMATCH",
            )
          ? "WAITING_FOR_FIRST_USE"
          : "UNAVAILABLE",
      completeness: confirmed.length === eligible.length ? "FULL" : "PARTIAL",
      freshness:
        oldest && now - new Date(oldest).getTime() <= freshnessMs
          ? "FRESH"
          : "STALE",
      lastConfirmedAt: timestamps.at(-1) ?? null,
      oldestConfirmedAt: oldest,
      summary,
      packages,
    };
  }

  private reference(value: string) {
    const secret =
      process.env.PARTNER_PACKAGE_REFERENCE_SECRET ??
      process.env.ENCRYPTION_KEY ??
      "visa-compass-package-reference";
    return `pkg_${createHmac("sha256", secret).update(value).digest("hex").slice(0, 20)}`;
  }

  private awaitingBalancePublication(subscription: any, now: Date) {
    if (!subscription.assignedAt) return false;
    const configured = Number(
      process.env.PROVIDER_BALANCE_PUBLICATION_GRACE_MINUTES ?? 60,
    );
    const graceMinutes =
      Number.isFinite(configured) && configured >= 1 ? configured : 60;
    return (
      now.getTime() - new Date(subscription.assignedAt).getTime() <
      graceMinutes * 60_000
    );
  }
}
