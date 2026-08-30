import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AttentionCaseStatus, UserRoleName } from "@prisma/client";
import { UserRole } from "@visa-compass/shared";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
  requireRole,
} from "../../common/auth.guard.js";
import { ProductionResilienceService } from "../../jobs/production-resilience.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ReconciliationService } from "../../jobs/reconciliation.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { NotificationService } from "../notification/notification.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { PaymentDisputesService } from "../payments/payment-disputes.service.js";
import { ManualRefundsService } from "../payments/manual-refunds.service.js";

@Controller("operations/attention")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class AttentionController {
  constructor(
    private readonly resilience: ProductionResilienceService,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly reconciliation: ReconciliationService,
    private readonly inventory: InventoryService,
    private readonly connectivity: ConnectivityService,
    private readonly notifications: NotificationService,
    private readonly orders: OrdersService,
    private readonly paymentDisputes: PaymentDisputesService,
    private readonly refunds: ManualRefundsService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query("status") status?: AttentionCaseStatus,
    @Query("category") category?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.resilience.list({
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
      limit: Number(limit || 50),
      offset: Number(offset || 0),
    });
  }

  @Get("platform-health")
  async health(@Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const [platform, connectivity] = await Promise.all([
      this.resilience.platformHealth(),
      this.connectivity.health().catch((error) => ({
        ok: false,
        detail: error instanceof Error ? error.message : "unavailable",
      })),
    ]);
    return {
      ...platform,
      dependencies: {
        connectivity,
        notifications: this.notifications.health(),
        s3: ["AWS_REGION", "AWS_S3_BUCKET"].every((key) =>
          Boolean(process.env[key]),
        )
          ? "CONFIGURED"
          : "CONFIG_REQUIRED",
        paymentGateway: process.env.KHALTI_SECRET_KEY
          ? "CONFIGURED"
          : "CONFIG_REQUIRED",
      },
    };
  }

  @Get(":id")
  item(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.resilience.item(id);
  }

  @Post(":id/resolve")
  async resolve(
    @Param("id") id: string,
    @Body() body: { resolution?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const item = await this.resilience.item(id);
    return this.resilience.resolve(
      item.dedupeKey,
      request.user!.localUserId ?? null,
      body.resolution ?? "Resolved by operations",
    );
  }

  @Post(":id/action")
  async action(
    @Param("id") id: string,
    @Body() body: { action?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const item = await this.resilience.item(id);
    const result = await this.runAction(item, body.action ?? "");
    await this.prisma.auditLog.create({
      data: {
        module: "OPERATIONS_ATTENTION",
        entity: item.entityType,
        entityId: item.entityId,
        action: body.action ?? "UNKNOWN",
        performedById: request.user!.localUserId ?? undefined,
        newValue: { attentionCaseId: item.id },
      },
    });
    return result;
  }

  @Post("bulk/action")
  async bulk(
    @Body() body: { ids?: string[]; action?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    requireRole(request, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const ids = [...new Set(body.ids ?? [])].slice(0, 100);
    if (!ids.length)
      throw new BadRequestException("At least one attention case is required");
    if (
      ![
        "RECHECK_INVENTORY",
        "RECONCILE_RESERVATION",
        "REPLAY_WEBHOOK",
        "RECONCILE_PROVISIONING",
      ].includes(body.action ?? "")
    )
      throw new BadRequestException("Bulk action is not permitted");
    const results = [];
    for (const id of ids) {
      try {
        results.push({
          id,
          ok: true,
          result: await this.runAction(
            await this.resilience.item(id),
            body.action!,
          ),
        });
      } catch (error) {
        results.push({
          id,
          ok: false,
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return { results };
  }

  private async runAction(
    item: Awaited<ReturnType<ProductionResilienceService["item"]>>,
    action: string,
  ) {
    if (
      !Array.isArray(item.availableActions) ||
      !item.availableActions.includes(action)
    )
      throw new BadRequestException("Action is not safe for this case");
    if (action === "RECHECK_PAYMENT") {
      const payment = item.order?.payments.at(-1);
      if (!item.orderId || !payment)
        throw new BadRequestException("Payment is unavailable");
      return this.payments.verifyCallback(
        item.orderId,
        payment.paymentReference,
      );
    }
    if (action === "RECHECK_INVENTORY")
      return this.inventory.reconcileProviderProfile(item.entityId);
    if (action === "RECHECK_ORDER_PROVIDER") {
      if (!item.orderId) throw new BadRequestException("Order is unavailable");
      const inventory = await this.inventory.inventoryForOrder(item.orderId);
      if (!inventory?.iccid)
        throw new BadRequestException("Assigned inventory is unavailable");
      return this.connectivity.getEsimDetails(inventory.iccid);
    }
    if (action === "RECONCILE_RESERVATION")
      return this.inventory.reconcileReservation(item.entityId);
    if (action === "RECONCILE_PROVISIONING")
      return this.reconciliation.reconcileProvisioningOperationNow(
        item.entityId,
      );
    if (action === "RECONCILE_ORDER_PROVISIONING") {
      if (!item.orderId) throw new BadRequestException("Order is unavailable");
      const operation = await this.prisma.provisioningOperation.findUnique({
        where: { orderId: item.orderId },
        select: { id: true },
      });
      if (!operation)
        throw new BadRequestException("Provisioning operation is unavailable");
      return this.reconciliation.reconcileProvisioningOperationNow(
        operation.id,
      );
    }
    if (action === "RETRY_PROVISIONING") {
      if (!item.orderId) throw new BadRequestException("Order is unavailable");
      return this.orders.retry(item.orderId);
    }
    if (action === "RETRY_NOTIFICATION") {
      const notification = await this.prisma.notification.findUnique({
        where: { id: item.entityId },
      });
      if (!notification?.recipient || !notification.orderNumber)
        throw new BadRequestException(
          "Notification delivery details are unavailable",
        );
      return this.notifications.retry(
        notification.id,
        notification.recipient,
        notification.orderNumber,
      );
    }
    if (action === "REVIEW_FINANCIAL_DISPUTE")
      return this.paymentDisputes.item(item.entityId);
    if (action === "REVIEW_MANUAL_REFUND")
      return this.refunds.item(item.entityId);
    if (action === "REPLAY_WEBHOOK") {
      const event = await this.prisma.webhookEvent.findUnique({
        where: { id: item.entityId },
      });
      if (!event) throw new BadRequestException("Webhook event is unavailable");
      const source = event.source.toLowerCase();
      const topic =
        source === "transatel"
          ? "providerCallbacks"
          : source === "khalti"
            ? "payments"
            : source === "clerk"
              ? "identityCallbacks"
              : null;
      if (!topic)
        throw new BadRequestException(`Replay is not supported for ${source}`);
      await this.resilience.outbox({
        dedupeKey: `ops-replay:${source}:${event.eventId}:${Date.now()}`,
        topic,
        jobName:
          source === "transatel"
            ? "connectivity-callback"
            : source === "clerk"
              ? "clerk-callback"
              : "payment-callback",
        payload: {
          provider: source,
          eventId: event.eventId,
          payload: event.payload,
        },
      });
      return this.resilience.dispatchOutbox();
    }
    throw new BadRequestException(`Action ${action} is not implemented`);
  }
}
