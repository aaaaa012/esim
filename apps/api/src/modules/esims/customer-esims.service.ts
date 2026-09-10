import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import QRCode from "qrcode";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { CryptoService } from "../../infrastructure/crypto.service.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { UsageService } from "./usage.service.js";
import { QueueService } from "../../jobs/queue.service.js";

@Injectable()
export class CustomerEsimsService {
  private readonly refreshedAt = new Map<string, number>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly crypto: CryptoService,
    @Optional() private readonly usageService?: UsageService,
    @Optional() private readonly queues?: QueueService,
  ) {}

  async list(ownerId: string) {
    if (!this.prisma.enabled) return [];
    const customer = await this.customer(ownerId);
    if (!customer) return [];
    const rows = await this.prisma.esimInventory.findMany({
      where: { customerEsims: this.ownedAssignment(customer.id) },
      include: {
        customerEsims: {
          include: {
            order: { include: { plan: { include: { country: true } } } },
            subscriptions: true,
          },
          orderBy: { assignedAt: "desc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) =>
      this.toView(row, this.usageService?.viewFromInventory(row)),
    );
  }

  async get(ownerId: string, id: string) {
    const items = await this.list(ownerId);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new NotFoundException("eSIM not found");
    return item;
  }

  async refresh(ownerId: string, id: string) {
    const customer = await this.customer(ownerId);
    if (!customer) throw new NotFoundException("eSIM not found");
    const row = await this.prisma.esimInventory.findFirst({
      where: { id, customerEsims: this.ownedAssignment(customer.id) },
      include: {
        customerEsims: {
          include: { subscriptions: true },
        },
      },
    });
    if (!row) throw new NotFoundException("eSIM not found");
    const last = this.refreshedAt.get(`${customer.id}:${id}`) ?? 0;
    if (Date.now() - last < 30_000)
      throw new HttpException(
        "Usage was refreshed recently. Please wait before trying again.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (this.queues?.enabled) {
      try {
        const shared = await this.queues.consumeRateLimit(
          `customer-usage-refresh:${customer.id}:${id}`,
          30_000,
        );
        if (shared.count > 1)
          throw new HttpException(
            "Usage was refreshed recently. Please wait before trying again.",
            HttpStatus.TOO_MANY_REQUESTS,
          );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        // The process-local guard remains available during a Redis incident.
      }
    }
    if (!row.iccid)
      throw new BadRequestException(
        "Usage is unavailable until the eSIM is provisioned",
      );
    if (this.usageService) {
      const refreshed = await this.usageService.refresh(row.id);
      this.refreshedAt.set(`${customer.id}:${id}`, Date.now());
      return refreshed;
    }
    const usage = await this.connectivity.getUsage(row.iccid);
    if (usage.usageAvailable === false && !usage.subscriptions?.length)
      throw new BadRequestException(
        "Transatel found the subscription but has not published a usable data balance yet. Please retry shortly.",
      );
    const subscriptions = row.customerEsims
      .flatMap((item) => item.subscriptions)
      .filter((item) => item.status === "ACTIVE" || item.status === "PENDING");
    const checkedAt = new Date();
    if (usage.subscriptions?.length) {
      const providerBalances = new Map(
        usage.subscriptions.map((item) => [item.providerSubscriptionId, item]),
      );
      await Promise.all(
        subscriptions.map((subscription) => {
          const balance = providerBalances.get(
            subscription.providerSubscriptionId,
          );
          if (!balance) return Promise.resolve();
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
              providerLastSeenAt: checkedAt,
              assignmentVerificationStatus: "VERIFIED",
              assignmentVerifiedAt:
                subscription.assignmentVerifiedAt ?? checkedAt,
            },
          });
        }),
      );
    }
    this.refreshedAt.set(`${customer.id}:${id}`, Date.now());
    return {
      usedMb: usage.usedMb,
      totalMb: usage.totalMb,
      remainingMb: Math.max(0, usage.totalMb - usage.usedMb),
      lastCheckedAt: checkedAt.toISOString(),
    };
  }

  async activationQr(ownerId: string, id: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Activation QR is unavailable right now");
    const customer = await this.customer(ownerId);
    if (!customer) throw new NotFoundException("eSIM not found");
    const row = await this.prisma.esimInventory.findFirst({
      where: { id, customerEsims: this.ownedAssignment(customer.id) },
      select: {
        customerEsims: {
          where: {
            order: {
              customerId: customer.id,
              orderType: "INITIAL_PURCHASE",
              status: { in: [OrderStatus.QR_READY, OrderStatus.COMPLETED] },
            },
          },
          orderBy: { assignedAt: "asc" },
          take: 1,
          select: { qrPayloadEncrypted: true },
        },
      },
    });
    if (!row) throw new NotFoundException("eSIM not found");
    const encrypted = row.customerEsims[0]?.qrPayloadEncrypted;
    if (!encrypted)
      throw new BadRequestException("Your activation QR is not ready yet");
    const qrPayload = this.crypto.decrypt(encrypted);
    const bytes = await QRCode.toBuffer(qrPayload, {
      width: 720,
      margin: 3,
      errorCorrectionLevel: "M",
    });
    return {
      filename: "visa-compass-esim-activation.png",
      contentType: "image/png",
      bytes,
    };
  }

  private ownedAssignment(customerId: string) {
    return {
      some: { order: { orderType: "INITIAL_PURCHASE" as const, customerId } },
      none: {
        order: {
          orderType: "INITIAL_PURCHASE" as const,
          customerId: { not: customerId },
        },
      },
    };
  }

  private async customer(ownerId: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(ownerId);
    return this.prisma.customer.findFirst({
      where: {
        OR: [
          { user: { clerkId: ownerId } },
          ...(isUuid ? [{ id: ownerId }] : []),
        ],
      },
      select: { id: true },
    });
  }

  private toView(
    row: any,
    canonical?: ReturnType<UsageService["viewFromInventory"]>,
  ) {
    const subscriptions = row.customerEsims.flatMap((link: any) =>
      link.subscriptions.map((subscription: any) => ({
        id: subscription.id,
        orderId: link.order.id,
        orderNumber: link.order.orderNumber,
        status: subscription.status,
        plan: {
          id: link.order.plan.id,
          name: link.order.plan.name,
          countryCode: link.order.plan.country.isoCode,
          countryName: link.order.plan.country.name,
          dataAllowance: link.order.plan.dataAllowance,
          validityDays: link.order.plan.validityDays,
        },
        usedMb: subscription.usedMb,
        totalMb: subscription.totalMb,
        remainingMb: Math.max(0, subscription.totalMb - subscription.usedMb),
        activatedAt: subscription.activatedAt?.toISOString(),
        expiresAt: subscription.activatedAt
          ? subscription.expiresAt?.toISOString()
          : undefined,
        lastCheckedAt: subscription.usageLastCheckedAt?.toISOString(),
        assignmentVerificationStatus: subscription.assignmentVerificationStatus,
        assignmentVerifiedAt: subscription.assignmentVerifiedAt?.toISOString(),
        providerLastSeenAt: subscription.providerLastSeenAt?.toISOString(),
      })),
    );
    const active = subscriptions.filter(
      (item: any) => item.status === "ACTIVE" || item.status === "PENDING",
    );
    const measured = active.filter((item: any) => item.lastCheckedAt);
    const lastCheckedAt = measured
      .map((item: any) => item.lastCheckedAt)
      .sort()
      .at(-1);
    const usage = measured.length
      ? measured.reduce(
          (sum: any, item: any) => ({
            usedMb: sum.usedMb + item.usedMb,
            totalMb: sum.totalMb + item.totalMb,
            remainingMb: sum.remainingMb + item.remainingMb,
          }),
          { usedMb: 0, totalMb: 0, remainingMb: 0 },
        )
      : null;
    const qrOrder = row.customerEsims.find(
      (link: any) =>
        link.order.orderType === "INITIAL_PURCHASE" &&
        (link.order.status === "COMPLETED" || link.order.status === "QR_READY"),
    );
    const mask = (value?: string | null) =>
      value ? `${value.slice(0, 4)}••••${value.slice(-4)}` : undefined;
    return {
      id: row.id,
      status:
        subscriptions.some((item: any) => item.status === "SUSPENDED") &&
        !active.length
          ? "SUSPENDED"
          : active.length
            ? row.status
            : "NO_ACTIVE_PLAN",
      iccidMasked: mask(row.iccid),
      msisdnMasked: mask(row.msisdn),
      activatedAt: row.activatedAt?.toISOString(),
      expiresAt: row.expiresAt?.toISOString(),
      usage: canonical
        ? canonical.usageStatus === "AVAILABLE"
          ? {
              ...canonical.summary,
              lastCheckedAt: canonical.lastConfirmedAt,
              oldestConfirmedAt: canonical.oldestConfirmedAt,
              completeness: canonical.completeness,
              freshness: canonical.freshness,
            }
          : null
        : usage
          ? { ...usage, lastCheckedAt }
          : null,
      usageStatus: canonical?.usageStatus,
      completeness: canonical?.completeness,
      freshness: canonical?.freshness,
      summary: canonical?.summary,
      subscriptions: (canonical?.packages ?? subscriptions).sort(
        (a: any, b: any) =>
          (b.activatedAt ?? "").localeCompare(a.activatedAt ?? ""),
      ),
      qrOrderId: qrOrder?.order.id,
      activity: row.customerEsims
        .map((link: any) => ({
          orderId: link.order.id,
          orderNumber: link.order.orderNumber,
          orderStatus: link.order.status,
          purchaseType: link.order.orderType ?? "INITIAL_PURCHASE",
          planName: link.order.plan.name,
          countryCode: link.order.plan.country.isoCode,
          createdAt:
            link.order.createdAt?.toISOString?.() ??
            link.assignedAt?.toISOString?.() ??
            new Date(0).toISOString(),
        }))
        .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
}
