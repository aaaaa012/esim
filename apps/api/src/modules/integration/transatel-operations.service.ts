import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  InventoryStatus,
  Prisma,
  SubscriptionStatus,
  TransatelLifecycleAction,
  TransatelLifecycleState,
} from "@prisma/client";
import { ApiErrorCode } from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ApiException } from "../../common/api-error.js";
import { ConnectivityService } from "./connectivity.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { UsageService } from "../esims/usage.service.js";

type LifecycleInput = {
  orderId: string;
  action: TransatelLifecycleAction;
  reason: string;
  idempotencyKey: string;
  actorId: string;
};

function canonicalSubscriptionStatus(status: string | null) {
  if (!status) return null;
  if (["ACTIVE", "ACTIVATED"].includes(status))
    return SubscriptionStatus.ACTIVE;
  if (status === "SUSPENDED") return SubscriptionStatus.SUSPENDED;
  if (status === "EXPIRED") return SubscriptionStatus.EXPIRED;
  if (status === "TERMINATED") return SubscriptionStatus.TERMINATED;
  if (["FAILED", "REJECTED"].includes(status)) return SubscriptionStatus.FAILED;
  if (
    [
      "PENDING",
      "PRELOADED",
      "SUBSCRIBED",
      "READYFORUSE",
      "PENDINGFORFIRSTUSE",
      "SCHEDULED",
    ].includes(status)
  )
    return SubscriptionStatus.PENDING;
  // A recurring-product cancellation remains usable until its expiration
  // event. Unknown statuses are also preserved for manual review.
  return null;
}

function canonicalSubscriberStatus(status: string | null) {
  if (!status) return null;
  const normalized = status.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (["ACTIVE", "ACTIVATED", "REACTIVATED"].includes(normalized))
    return "ACTIVE";
  if (normalized === "SUSPENDED") return "SUSPENDED";
  if (normalized === "TERMINATED") return "TERMINATED";
  if (normalized === "PREACTIVATED") return "PREACTIVATED";
  if (normalized === "TESTMODE") return "TESTMODE";
  if (normalized === "TARIFFHOLIDAY") return "TARIFFHOLIDAY";
  if (normalized === "AVAILABLE") return "AVAILABLE";
  if (normalized === "LOADED") return "LOADED";
  return status.toUpperCase();
}

function dashboardProviderStatus(input: {
  orderStatus: string | null;
  inventoryProviderStatus: string | null;
  inventoryStatus: string;
}) {
  const inventoryProvider =
    input.inventoryProviderStatus?.toUpperCase() ?? null;
  if (input.orderStatus) return canonicalSubscriberStatus(input.orderStatus);
  if (input.inventoryStatus === InventoryStatus.TERMINATED) return "TERMINATED";
  return inventoryProvider;
}

@Injectable()
export class TransatelOperationsService {
  private readonly logger = new Logger(TransatelOperationsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly orders: OrdersService,
    @Optional() private readonly usageService?: UsageService,
  ) {}

  async dashboard(params?: {
    scope?: "subscribers" | "inventory" | "failures" | "actions";
    q?: string;
  }) {
    const health = await this.connectivity.transatelHealth().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : "Health check failed",
    }));
    if (!this.prisma.enabled)
      return {
        health,
        persistence: "DISABLED",
        counts: {
          available: 0,
          quarantined: 0,
          activeSubscriptions: 0,
          suspended: 0,
          provisioningAttention: 0,
          webhookDeadLetters: 0,
        },
        subscribers: [],
        inventory: [],
        failures: [],
        lifecycleOperations: [],
      };
    const attentionStates = [
      "RECONCILE_REQUIRED",
      "REJECTED",
      "MANUAL_REVIEW",
    ] as const;
    const query = params?.q?.trim().slice(0, 200);
    const normalizedQuery = query?.toUpperCase().replaceAll(" ", "_");
    const subscriptionStatus =
      normalizedQuery &&
      Object.values(SubscriptionStatus).includes(
        normalizedQuery as SubscriptionStatus,
      )
        ? (normalizedQuery as SubscriptionStatus)
        : undefined;
    const inventoryStatus =
      normalizedQuery &&
      Object.values(InventoryStatus).includes(
        normalizedQuery as InventoryStatus,
      )
        ? (normalizedQuery as InventoryStatus)
        : undefined;
    const lifecycleAction =
      normalizedQuery &&
      Object.values(TransatelLifecycleAction).includes(
        normalizedQuery as TransatelLifecycleAction,
      )
        ? (normalizedQuery as TransatelLifecycleAction)
        : undefined;
    const lifecycleState =
      normalizedQuery &&
      Object.values(TransatelLifecycleState).includes(
        normalizedQuery as TransatelLifecycleState,
      )
        ? (normalizedQuery as TransatelLifecycleState)
        : undefined;
    const subscriberWhere: Prisma.SubscriptionWhereInput = {
      provider: "TRANSATEL",
      ...(query && params?.scope === "subscribers"
        ? {
            OR: [
              {
                providerSubscriptionId: {
                  contains: query,
                  mode: "insensitive",
                },
              },
              ...(subscriptionStatus ? [{ status: subscriptionStatus }] : []),
              {
                customerEsim: {
                  is: {
                    OR: [
                      {
                        inventory: {
                          is: {
                            OR: [
                              {
                                iccid: { contains: query, mode: "insensitive" },
                              },
                              { eid: { contains: query, mode: "insensitive" } },
                              {
                                msisdn: {
                                  contains: query,
                                  mode: "insensitive",
                                },
                              },
                            ],
                          },
                        },
                      },
                      {
                        customer: {
                          is: {
                            OR: [
                              {
                                email: { contains: query, mode: "insensitive" },
                              },
                              {
                                customerCode: {
                                  contains: query,
                                  mode: "insensitive",
                                },
                              },
                              {
                                phone: { contains: query, mode: "insensitive" },
                              },
                            ],
                          },
                        },
                      },
                      {
                        order: {
                          is: {
                            OR: [
                              {
                                orderNumber: {
                                  contains: query,
                                  mode: "insensitive",
                                },
                              },
                              {
                                externalOrderId: {
                                  contains: query,
                                  mode: "insensitive",
                                },
                              },
                              {
                                traveler: {
                                  is: {
                                    OR: [
                                      {
                                        firstName: {
                                          contains: query,
                                          mode: "insensitive",
                                        },
                                      },
                                      {
                                        surname: {
                                          contains: query,
                                          mode: "insensitive",
                                        },
                                      },
                                      {
                                        email: {
                                          contains: query,
                                          mode: "insensitive",
                                        },
                                      },
                                      {
                                        mobile: {
                                          contains: query,
                                          mode: "insensitive",
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                              {
                                plan: {
                                  is: {
                                    name: {
                                      contains: query,
                                      mode: "insensitive",
                                    },
                                  },
                                },
                              },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const inventoryWhere: Prisma.EsimInventoryWhereInput = {
      assignedOrderId: null,
      ...(query && params?.scope === "inventory"
        ? {
            OR: [
              { iccid: { contains: query, mode: "insensitive" } },
              { eid: { contains: query, mode: "insensitive" } },
              { msisdn: { contains: query, mode: "insensitive" } },
              {
                providerSubscriptionId: {
                  contains: query,
                  mode: "insensitive",
                },
              },
              { providerStatus: { contains: query, mode: "insensitive" } },
              ...(inventoryStatus ? [{ status: inventoryStatus }] : []),
              {
                batch: {
                  is: {
                    batchReference: { contains: query, mode: "insensitive" },
                  },
                },
              },
            ],
          }
        : {}),
    };
    const failureWhere: Prisma.IntegrationLogWhereInput = {
      AND: [
        { OR: [{ status: { gte: 400 } }, { errorCode: { not: null } }] },
        ...(query && params?.scope === "failures"
          ? [
              {
                OR: [
                  {
                    operation: {
                      contains: query,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    endpoint: { contains: query, mode: "insensitive" as const },
                  },
                  {
                    errorCode: {
                      contains: query,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    errorMessage: {
                      contains: query,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    correlationId: {
                      contains: query,
                      mode: "insensitive" as const,
                    },
                  },
                  ...(/^\d{3}$/.test(query) ? [{ status: Number(query) }] : []),
                ],
              },
            ]
          : []),
      ],
    };
    const lifecycleWhere: Prisma.TransatelLifecycleOperationWhereInput =
      query && params?.scope === "actions"
        ? {
            OR: [
              {
                order: {
                  is: { orderNumber: { contains: query, mode: "insensitive" } },
                },
              },
              {
                performedBy: {
                  is: { email: { contains: query, mode: "insensitive" } },
                },
              },
              { reason: { contains: query, mode: "insensitive" } },
              {
                providerTransactionId: { contains: query, mode: "insensitive" },
              },
              { idempotencyKey: { contains: query, mode: "insensitive" } },
              { errorMessage: { contains: query, mode: "insensitive" } },
              ...(lifecycleAction ? [{ action: lifecycleAction }] : []),
              ...(lifecycleState ? [{ state: lifecycleState }] : []),
            ],
          }
        : {};
    const [
      available,
      quarantined,
      activeSubscriptions,
      suspended,
      provisioningAttention,
      webhookDeadLetters,
      subscribers,
      inventory,
      failures,
      lifecycleOperations,
    ] = await Promise.all([
      this.prisma.esimInventory.count({ where: { status: "AVAILABLE" } }),
      this.prisma.esimInventory.count({ where: { status: "QUARANTINED" } }),
      this.prisma.subscription.count({ where: { status: "ACTIVE" } }),
      this.prisma.order.count({ where: { providerStatus: "SUSPENDED" } }),
      this.prisma.provisioningOperation.count({
        where: { state: { in: [...attentionStates] } },
      }),
      this.prisma.webhookEvent.count({
        where: { source: "transatel", deadLetteredAt: { not: null } },
      }),
      this.prisma.subscription.findMany({
        where: subscriberWhere,
        include: {
          customerEsim: {
            include: {
              inventory: true,
              customer: { include: { user: { select: { email: true } } } },
              order: {
                include: {
                  plan: { include: { country: true } },
                  traveler: true,
                },
              },
            },
          },
        },
        orderBy: { customerEsim: { assignedAt: "desc" } },
        take: 100,
      }),
      this.prisma.esimInventory.findMany({
        where: inventoryWhere,
        include: { batch: true },
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
      this.prisma.integrationLog.findMany({
        where: failureWhere,
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      this.prisma.transatelLifecycleOperation.findMany({
        where: lifecycleWhere,
        include: {
          order: { select: { orderNumber: true } },
          performedBy: { select: { email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return {
      health,
      persistence: "ENABLED",
      counts: {
        available,
        quarantined,
        activeSubscriptions,
        suspended,
        provisioningAttention,
        webhookDeadLetters,
      },
      subscribers: subscribers.map((subscription) => ({
        orderId: subscription.customerEsim.orderId,
        orderNumber: subscription.customerEsim.order.orderNumber,
        ownerId: subscription.customerEsim.customerId,
        customer: subscription.customerEsim.order.traveler
          ? `${subscription.customerEsim.order.traveler.firstName} ${subscription.customerEsim.order.traveler.surname}`
          : (subscription.customerEsim.customer.user?.email ?? "Customer"),
        email: subscription.customerEsim.customer.user?.email ?? "—",
        iccid: subscription.customerEsim.inventory.iccid,
        msisdn: subscription.customerEsim.inventory.msisdn,
        providerSubscriptionId: subscription.providerSubscriptionId,
        status: subscription.status,
        providerStatus: dashboardProviderStatus({
          orderStatus: subscription.customerEsim.order.providerStatus,
          inventoryProviderStatus:
            subscription.customerEsim.inventory.providerStatus,
          inventoryStatus: subscription.customerEsim.inventory.status,
        }),
        plan: `${subscription.customerEsim.order.plan.country.isoCode} · ${subscription.customerEsim.order.plan.name}`,
        usedMb: subscription.usedMb,
        totalMb: subscription.totalMb,
        remainingMb: Math.max(0, subscription.totalMb - subscription.usedMb),
        usageLastCheckedAt:
          subscription.usageLastCheckedAt?.toISOString() ?? null,
        expiresAt: subscription.expiresAt?.toISOString() ?? null,
      })),
      inventory: inventory.map((profile) => ({
        id: profile.id,
        iccid: profile.iccid,
        msisdn: profile.msisdn,
        status: profile.status,
        providerStatus: profile.providerStatus,
        lastProviderCheckedAt:
          profile.lastProviderCheckedAt?.toISOString() ?? null,
        providerCheckError: profile.providerCheckError,
        quarantineReason: profile.quarantineReason,
        batchReference: profile.batch.batchReference,
      })),
      failures: failures.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      })),
      lifecycleOperations: lifecycleOperations.map((operation) => ({
        id: operation.id,
        orderId: operation.orderId,
        orderNumber: operation.order.orderNumber,
        action: operation.action,
        state: operation.state,
        reason: operation.reason,
        actor: operation.performedBy.email,
        providerTransactionId: operation.providerTransactionId,
        errorMessage: operation.errorMessage,
        createdAt: operation.createdAt.toISOString(),
      })),
    };
  }

  suspend(input: Omit<LifecycleInput, "action">) {
    return this.lifecycle({
      ...input,
      action: TransatelLifecycleAction.SUSPEND,
    });
  }
  terminate(input: Omit<LifecycleInput, "action">) {
    return this.lifecycle({
      ...input,
      action: TransatelLifecycleAction.TERMINATE,
    });
  }

  async diagnostics() {
    const health = await this.connectivity.transatelHealth();
    if (!this.prisma.enabled)
      return {
        health,
        checks: [],
        webhook: { configured: false },
        checkedAt: new Date().toISOString(),
      };
    const [logs, webhook, deadLetters] = await Promise.all([
      this.prisma.integrationLog.findMany({
        where: {
          operation: {
            in: [
              "token",
              "catalog",
              "inventory",
              "esim-details",
              "usage",
              "provision",
              "subscriber-suspend",
              "subscriber-terminate",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      this.prisma.webhookEvent.findFirst({
        where: { source: "transatel" },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.webhookEvent.count({
        where: { source: "transatel", deadLetteredAt: { not: null } },
      }),
    ]);
    const operations = [
      "token",
      "catalog",
      "inventory",
      "esim-details",
      "usage",
      "provision",
      "subscriber-suspend",
      "subscriber-terminate",
    ];
    return {
      health,
      checks: operations.map((operation) => {
        const row = logs.find((item) => item.operation === operation);
        return {
          operation,
          status: row
            ? row.status >= 200 && row.status < 400
              ? "PASS"
              : "FAIL"
            : "NOT_RUN",
          httpStatus: row?.status ?? null,
          durationMs: row?.durationMs ?? null,
          correlationId: row?.correlationId ?? null,
          error: row?.errorCode ?? null,
          checkedAt: row?.createdAt.toISOString() ?? null,
        };
      }),
      webhook: {
        configured: Boolean(
          process.env.TRANSATEL_WEBHOOK_TARGET_URL &&
          process.env.TRANSATEL_WEBHOOK_SECRET,
        ),
        targetUrl: process.env.TRANSATEL_WEBHOOK_TARGET_URL ?? null,
        lastReceivedAt: webhook?.createdAt.toISOString() ?? null,
        lastProcessedAt: webhook?.processedAt?.toISOString() ?? null,
        deadLetters,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async reconcile(orderId: string, actorId?: string) {
    if (!this.prisma.enabled)
      throw new ServiceUnavailableException("Database persistence is required");
    const storedOrder = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        inventory: true,
        customerEsim: { include: { subscriptions: true, inventory: true } },
        transatelLifecycleOperations: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        provisioningOperation: { select: { state: true } },
      },
    });
    const order = storedOrder
      ? {
          ...storedOrder,
          inventory:
            storedOrder.inventory ?? storedOrder.customerEsim?.inventory,
        }
      : null;
    if (!order?.inventory)
      throw new NotFoundException("The order does not have an assigned eSIM");
    const details = await this.connectivity.getEsimDetails(
      order.inventory.iccid,
    );
    const observedProfileStatus = details.status.toUpperCase();
    let subscriberStatusUnavailable = false;
    const subscriber = await this.connectivity
      .getSubscriberDetails(order.inventory.iccid)
      .catch(() => {
        subscriberStatusUnavailable = true;
        return null;
      });
    const observedSubscriberStatus = canonicalSubscriberStatus(
      subscriber?.status ?? null,
    );
    let usageUnavailable = false;
    const usage = await this.connectivity
      .getUsage(order.inventory.iccid)
      .catch(() => {
        usageUnavailable = true;
        return null;
      });
    const providerSubscription = usage?.subscriptions?.find(
      (subscription) =>
        !order.providerSubscriptionId ||
        subscription.providerSubscriptionId === order.providerSubscriptionId,
    );
    const observedSubscriptionStatus =
      providerSubscription?.status.toUpperCase() ?? null;
    const canonicalProviderStatus =
      observedSubscriberStatus ?? order.providerStatus;
    const subscriberTerminal = observedSubscriberStatus === "TERMINATED";
    const activationConfirmed =
      canonicalSubscriptionStatus(observedSubscriptionStatus) ===
        SubscriptionStatus.ACTIVE &&
      !["DELETED", "TERMINATED"].includes(observedProfileStatus) &&
      ["ACTIVE", "TESTMODE"].includes(observedSubscriberStatus ?? "");
    const observedState = canonicalProviderStatus ?? observedProfileStatus;
    const terminal = subscriberTerminal;
    const providerStatusUnavailable =
      usageUnavailable || subscriberStatusUnavailable;
    const awaitingInstallation = [
      "READYFORUSE",
      "SCHEDULED",
      "PENDINGFORFIRSTUSE",
      "PENDING",
      "PRELOADED",
    ].includes(observedSubscriptionStatus ?? "");
    const identityMismatch = Boolean(
      order.providerSubscriptionId &&
      usage?.subscriptions?.length &&
      !providerSubscription,
    );
    const profileDeleted = observedProfileStatus === "DELETED";
    const critical = terminal || identityMismatch || profileDeleted;
    const movesOrderToAttention =
      critical &&
      ["PROVISIONING", "QR_READY", "ACTIVATION_ATTENTION"].includes(
        order.status,
      );
    const checkedAt = new Date();
    if (
      activationConfirmed &&
      ["PROVISIONING", "QR_READY", "ACTIVATION_ATTENTION"].includes(
        order.status,
      )
    ) {
      await this.orders.applyProviderEvent({
        eventType: "OPERATIONS/ESIM_STATUS_RECONCILED",
        orderId: order.id,
        iccid: order.inventory.iccid,
        ...(order.providerSubscriptionId
          ? { subscriptionId: order.providerSubscriptionId }
          : {}),
        status: "ACTIVATED",
        activatedAt: checkedAt.toISOString(),
      });
      await this.prisma.$transaction([
        this.prisma.order.update({
          where: { id: order.id },
          data: { providerStatus: "ACTIVE", version: { increment: 1 } },
        }),
        this.prisma.esimInventory.update({
          where: { id: order.inventory.id },
          data: {
            providerStatus: observedProfileStatus,
            lastProviderCheckedAt: checkedAt,
            providerCheckError: null,
            version: { increment: 1 },
          },
        }),
        ...(order.customerEsim && providerSubscription
          ? [
              this.prisma.subscription.updateMany({
                where: {
                  customerEsimId: order.customerEsim.id,
                  providerSubscriptionId:
                    providerSubscription.providerSubscriptionId,
                },
                data: {
                  status: SubscriptionStatus.ACTIVE,
                  providerLastSeenAt: checkedAt,
                  ...(usage?.usageAvailable !== false &&
                  providerSubscription?.usageAvailable !== false
                    ? {
                        usedMb: providerSubscription.usedMb,
                        totalMb: providerSubscription.totalMb,
                        usageLastCheckedAt: checkedAt,
                      }
                    : {}),
                },
              }),
            ]
          : []),
      ]);
      return {
        classification: "ACTIVE" as const,
        orderId,
        orderStatus: "COMPLETED",
        providerStatus: canonicalProviderStatus,
        profileStatus: observedProfileStatus,
        subscriberStatus: observedSubscriberStatus,
        subscriptionStatus: observedSubscriptionStatus,
        usageAvailable:
          Boolean(usage) &&
          usage?.usageAvailable !== false &&
          providerSubscription?.usageAvailable !== false,
        provisioningState: "ACTIVATED",
        changed: true,
        checkedAt: checkedAt.toISOString(),
        recommendedAction: "No action is required; activation is confirmed.",
      };
    }
    if (activationConfirmed)
      return {
        classification: "ACTIVE" as const,
        orderId,
        orderStatus: order.status,
        providerStatus: observedState,
        profileStatus: observedProfileStatus,
        subscriberStatus: observedSubscriberStatus,
        subscriptionStatus: observedSubscriptionStatus,
        usageAvailable:
          Boolean(usage) &&
          usage?.usageAvailable !== false &&
          providerSubscription?.usageAvailable !== false,
        provisioningState: order.provisioningOperation?.state ?? null,
        changed: false,
        checkedAt: checkedAt.toISOString(),
        recommendedAction: "No action is required; activation is confirmed.",
      };
    const latest = order.transatelLifecycleOperations[0];
    const confirmed =
      latest &&
      ((latest.action === TransatelLifecycleAction.SUSPEND &&
        observedSubscriberStatus === "SUSPENDED") ||
        (latest.action === TransatelLifecycleAction.TERMINATE &&
          observedSubscriberStatus === "TERMINATED"));
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          ...(canonicalProviderStatus &&
          canonicalProviderStatus !== order.providerStatus
            ? { providerStatus: canonicalProviderStatus }
            : {}),
          ...(movesOrderToAttention
            ? {
                status: "ACTIVATION_ATTENTION",
                operationalDisposition: "MANUAL_ACTION",
              }
            : {}),
          version: { increment: 1 },
        },
      });
      await tx.esimInventory.update({
        where: { id: order.inventory!.id },
        data: {
          providerStatus: observedProfileStatus,
          lastProviderCheckedAt: checkedAt,
          providerCheckError: null,
          ...(subscriberTerminal
            ? { status: InventoryStatus.TERMINATED }
            : observedSubscriberStatus &&
                order.inventory!.status === InventoryStatus.TERMINATED
              ? { status: InventoryStatus.ACTIVATED }
              : {}),
          version: { increment: 1 },
        },
      });
      if (order.customerEsim && providerSubscription) {
        const subscriptionStatus = canonicalSubscriptionStatus(
          observedSubscriptionStatus,
        );
        await tx.subscription.updateMany({
          where: {
            customerEsimId: order.customerEsim.id,
            providerSubscriptionId: providerSubscription.providerSubscriptionId,
          },
          data: {
            ...(subscriptionStatus ? { status: subscriptionStatus } : {}),
            providerLastSeenAt: checkedAt,
            ...(usage?.usageAvailable !== false &&
            providerSubscription?.usageAvailable !== false
              ? {
                  usedMb: providerSubscription.usedMb,
                  totalMb: providerSubscription.totalMb,
                  usageLastCheckedAt: checkedAt,
                }
              : {}),
          },
        });
      }
      if (latest && confirmed)
        await tx.transatelLifecycleOperation.update({
          where: { id: latest.id },
          data: {
            state: TransatelLifecycleState.CONFIRMED,
            responseSnapshot: {
              observedProfileStatus,
              observedSubscriberStatus,
              observedSubscriptionStatus,
              checkedAt: checkedAt.toISOString(),
            },
          },
        });
      if (movesOrderToAttention) {
        if (order.status !== "ACTIVATION_ATTENTION")
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              fromStatus: order.status,
              toStatus: "ACTIVATION_ATTENTION",
              reason: identityMismatch
                ? "Transatel subscription did not match the assigned order"
                : profileDeleted && !terminal
                  ? "Transatel reported that the assigned eSIM profile was deleted"
                  : `Transatel reported terminal state ${observedState}`,
            },
          });
        await tx.attentionCase.upsert({
          where: { dedupeKey: `provider-status-critical:${order.id}` },
          create: {
            dedupeKey: `provider-status-critical:${order.id}`,
            category: identityMismatch
              ? "PROVISIONING_IDENTITY_CONFLICT"
              : profileDeleted && !terminal
                ? "ESIM_PROFILE_DELETED"
                : "PROVIDER_TERMINAL_STATE",
            entityType: "Order",
            entityId: order.id,
            orderId: order.id,
            severity: "CRITICAL",
            summary: identityMismatch
              ? `Transatel subscription does not match ${order.orderNumber}`
              : profileDeleted && !terminal
                ? `Transatel profile was deleted for ${order.orderNumber}`
                : `Transatel reported ${observedState} for ${order.orderNumber}`,
            localState: "ACTIVATION_ATTENTION",
            externalState: observedState,
            lastSuccessfulStep: "PROVIDER_STATUS_CHECK",
            failureCategory: identityMismatch
              ? "PROVIDER_SUBSCRIPTION_MISMATCH"
              : profileDeleted && !terminal
                ? "ESIM_PROFILE_DELETED"
                : "PROVIDER_TERMINAL_STATE",
            availableActions: [],
          },
          update: {
            status: "OPEN",
            externalState: observedState,
            retryCount: { increment: 1 },
            resolvedAt: null,
            resolution: null,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          module: "TRANSATEL",
          entity: "Order",
          entityId: order.id,
          action: confirmed
            ? "LIFECYCLE_CONFIRMED"
            : "PROVIDER_STATUS_RECONCILED",
          ...(actorId ? { performedById: actorId } : {}),
          previousValue: {
            providerStatus: order.providerStatus,
          } as Prisma.InputJsonValue,
          newValue: {
            esimProfileStatus: observedProfileStatus,
            subscriberStatus: observedSubscriberStatus,
            subscriptionStatus: observedSubscriptionStatus,
            effectiveProviderStatus: canonicalProviderStatus,
            subscriberStatusUnavailable,
            operationId: latest?.id ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });
    return {
      classification: identityMismatch
        ? ("IDENTITY_MISMATCH" as const)
        : terminal
          ? ("PROVIDER_TERMINAL" as const)
          : profileDeleted
            ? ("PROFILE_DELETED" as const)
            : providerStatusUnavailable
              ? ("PROVIDER_UNAVAILABLE" as const)
              : awaitingInstallation
                ? order.orderType === "TOPUP"
                  ? ("AWAITING_ACTIVATION" as const)
                  : ("AWAITING_INSTALLATION" as const)
                : ("PROVISIONING_PENDING" as const),
      orderId,
      orderStatus: movesOrderToAttention
        ? "ACTIVATION_ATTENTION"
        : order.status,
      providerStatus: canonicalProviderStatus,
      profileStatus: observedProfileStatus,
      subscriberStatus: observedSubscriberStatus,
      subscriptionStatus: observedSubscriptionStatus,
      usageAvailable:
        Boolean(usage) &&
        usage?.usageAvailable !== false &&
        providerSubscription?.usageAvailable !== false,
      provisioningState: order.provisioningOperation?.state ?? null,
      changed: movesOrderToAttention && order.status !== "ACTIVATION_ATTENTION",
      checkedAt: checkedAt.toISOString(),
      recommendedAction: identityMismatch
        ? "Do not retry; verify the ICCID and subscription assignment with Transatel."
        : terminal
          ? "Review the provider rejection before creating a replacement or refund."
          : profileDeleted
            ? "The network subscriber remains separate from the deleted eSIM profile; verify whether the customer needs a replacement profile."
            : providerStatusUnavailable
              ? "Provider status is temporarily unavailable; local state was preserved."
              : awaitingInstallation
                ? order.orderType === "TOPUP"
                  ? "Package is added to the existing eSIM and awaiting activation. No new installation is required."
                  : "Ask the customer to install the eSIM and connect to a supported network."
                : "The provider setup is still pending; check again later.",
    };
  }

  private async lifecycle(input: LifecycleInput) {
    if (!this.prisma.enabled)
      throw new ServiceUnavailableException(
        "Transatel lifecycle operations require database persistence",
      );
    const reason = input.reason.trim();
    if (reason.length < 5 || reason.length > 500)
      throw new BadRequestException(
        "A reason between 5 and 500 characters is required",
      );
    if (!/^[a-zA-Z0-9:_-]{12,128}$/.test(input.idempotencyKey))
      throw new BadRequestException("A valid idempotency key is required");
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      include: {
        inventory: true,
        customerEsim: { include: { subscriptions: true } },
      },
    });
    if (!order?.inventory || !order.customerEsim)
      throw new NotFoundException("The order does not have an assigned eSIM");
    let subscriber;
    try {
      subscriber = await this.connectivity.getSubscriberDetails(
        order.inventory.iccid,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Provider subscriber status lookup failed";
      await this.prisma.auditLog
        .create({
          data: {
            module: "TRANSATEL",
            entity: "Order",
            entityId: order.id,
            action: `${input.action}_STATUS_CHECK_FAILED`,
            performedById: input.actorId,
            newValue: {
              reason,
              error: message,
              providerRequestSent: false,
            } as Prisma.InputJsonValue,
          },
        })
        .catch((auditError) =>
          this.logger.error(
            `Could not audit failed subscriber status check for order ${order.id}: ${auditError instanceof Error ? auditError.message : "unknown"}`,
          ),
        );
      throw new ApiException({
        code: ApiErrorCode.CONNECTIVITY_UNAVAILABLE,
        message:
          "The current network status could not be verified. No change was sent; please try again.",
        status: 503,
        details: { providerRequestSent: false },
      });
    }
    const canonicalLifecycleStatus = canonicalSubscriberStatus(
      subscriber.status,
    );
    const lifecycleStatus = canonicalLifecycleStatus ?? "UNKNOWN";
    if (!canonicalLifecycleStatus)
      await this.rejectLifecycle(
        input,
        "UNKNOWN",
        "The provider returned an unknown network status. No change was sent.",
      );
    if (lifecycleStatus === "TERMINATED") {
      await this.rejectLifecycle(
        input,
        lifecycleStatus,
        input.action === TransatelLifecycleAction.TERMINATE
          ? "This eSIM is already terminated"
          : "A terminated eSIM cannot be suspended",
      );
    }
    if (
      input.action === TransatelLifecycleAction.SUSPEND &&
      !["ACTIVE", "TESTMODE"].includes(lifecycleStatus)
    )
      await this.rejectLifecycle(
        input,
        lifecycleStatus,
        `Only an active eSIM can be suspended (current provider state: ${lifecycleStatus})`,
      );
    if (
      input.action === TransatelLifecycleAction.TERMINATE &&
      !["ACTIVE", "SUSPENDED", "TESTMODE", "TARIFFHOLIDAY"].includes(
        lifecycleStatus,
      )
    )
      await this.rejectLifecycle(
        input,
        lifecycleStatus,
        `This eSIM cannot be terminated from provider state ${lifecycleStatus}`,
      );
    const inFlight = await this.prisma.transatelLifecycleOperation.findFirst({
      where: {
        orderId: order.id,
        action: input.action,
        state: {
          in: [
            TransatelLifecycleState.CREATED,
            TransatelLifecycleState.SUBMITTING,
            TransatelLifecycleState.ACCEPTED,
            TransatelLifecycleState.RECONCILE_REQUIRED,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
    });
    if (inFlight && inFlight.idempotencyKey !== input.idempotencyKey)
      await this.rejectLifecycle(
        input,
        lifecycleStatus,
        `A ${input.action.toLowerCase()} operation is already pending provider confirmation`,
      );
    if (inFlight) return inFlight;
    const reference = order.inventory.iccid;
    const requestSnapshot = {
      orderId: order.id,
      iccid: order.inventory.iccid,
      providerSubscriptionId:
        order.inventory.providerSubscriptionId ??
        order.providerSubscriptionId ??
        null,
      observedSubscriberStatus: lifecycleStatus,
      action: input.action,
      reason,
    } as Prisma.InputJsonValue;
    let operation;
    try {
      operation = await this.prisma.transatelLifecycleOperation.create({
        data: {
          orderId: order.id,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          reason,
          performedById: input.actorId,
          requestSnapshot,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing =
          await this.prisma.transatelLifecycleOperation.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
        if (
          !existing ||
          existing.orderId !== order.id ||
          existing.action !== input.action
        )
          throw new ConflictException(
            "Idempotency key is already used for a different operation",
          );
        return existing;
      }
      throw error;
    }
    await this.prisma.transatelLifecycleOperation.update({
      where: { id: operation.id },
      data: {
        state: TransatelLifecycleState.SUBMITTING,
        submittedAt: new Date(),
      },
    });
    let providerAccepted = false;
    try {
      const result =
        input.action === TransatelLifecycleAction.SUSPEND
          ? await this.connectivity.suspend(reference, input.idempotencyKey)
          : await this.connectivity.terminate(reference, input.idempotencyKey);
      providerAccepted = true;
      const pendingStatus =
        input.action === TransatelLifecycleAction.SUSPEND
          ? "SUSPEND_PENDING"
          : "TERMINATION_PENDING";
      const acceptedAt = new Date();
      const completed = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.transatelLifecycleOperation.update({
          where: { id: operation.id },
          data: {
            state: TransatelLifecycleState.ACCEPTED,
            ...(result.transactionId
              ? { providerTransactionId: result.transactionId }
              : {}),
            responseSnapshot: result as Prisma.InputJsonValue,
            acceptedAt,
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { providerStatus: pendingStatus, version: { increment: 1 } },
        });
        await tx.esimInventory.update({
          where: { id: order.inventory!.id },
          data: {
            providerStatus: pendingStatus,
            lastProviderCheckedAt: acceptedAt,
            providerCheckError: null,
            version: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: {
            module: "TRANSATEL",
            entity: "Order",
            entityId: order.id,
            action: `${input.action}_ACCEPTED`,
            performedById: input.actorId,
            previousValue: {
              providerStatus: order.providerStatus,
            } as Prisma.InputJsonValue,
            newValue: {
              providerStatus: pendingStatus,
              reason,
              operationId: operation.id,
              providerTransactionId: result.transactionId ?? null,
            } as Prisma.InputJsonValue,
          },
        });
        return saved;
      });
      return completed;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Provider lifecycle request failed";
      const status =
        typeof (error as { getStatus?: unknown })?.getStatus === "function"
          ? (error as { getStatus: () => number }).getStatus()
          : 0;
      const ambiguous = providerAccepted || status === 0 || status >= 500;
      const nextState = ambiguous
        ? TransatelLifecycleState.RECONCILE_REQUIRED
        : TransatelLifecycleState.FAILED;
      await this.prisma.$transaction([
        this.prisma.transatelLifecycleOperation.update({
          where: { id: operation.id },
          data: { state: nextState, errorMessage: message },
        }),
        this.prisma.auditLog.create({
          data: {
            module: "TRANSATEL",
            entity: "Order",
            entityId: order.id,
            action: `${input.action}_${ambiguous ? "RECONCILE_REQUIRED" : "FAILED"}`,
            performedById: input.actorId,
            newValue: {
              reason,
              operationId: operation.id,
              error: message,
            } as Prisma.InputJsonValue,
          },
        }),
      ]);
      throw error;
    }
  }

  private async rejectLifecycle(
    input: LifecycleInput,
    providerStatus: string,
    message: string,
  ): Promise<never> {
    await this.prisma.auditLog
      .create({
        data: {
          module: "TRANSATEL",
          entity: "Order",
          entityId: input.orderId,
          action: `${input.action}_REJECTED`,
          performedById: input.actorId,
          newValue: {
            reason: input.reason.trim(),
            providerStatus,
            rejection: message,
            providerRequestSent: false,
          } as Prisma.InputJsonValue,
        },
      })
      .catch((error) =>
        this.logger.error(
          `Could not audit rejected ${input.action.toLowerCase()} for order ${input.orderId}: ${error instanceof Error ? error.message : "unknown"}`,
        ),
      );
    throw new ApiException({
      code: ApiErrorCode.ESIM_LIFECYCLE_NOT_ALLOWED,
      message,
      status: 409,
      details: { providerStatus, providerRequestSent: false },
    });
  }

  async syncAllUsage(): Promise<{ synced: number; failed: number }> {
    if (!this.prisma.enabled) return { synced: 0, failed: 0 };
    if (!this.usageService)
      throw new ServiceUnavailableException(
        "Canonical usage reconciliation is unavailable",
      );
    const profiles = await this.prisma.esimInventory.findMany({
      where: {
        customerEsims: {
          some: {
            subscriptions: {
              some: {
                status: {
                  in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING],
                },
              },
            },
          },
        },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    let synced = 0;
    let failed = 0;
    const concurrency = 5;
    for (let offset = 0; offset < profiles.length; offset += concurrency) {
      const results = await Promise.allSettled(
        profiles
          .slice(offset, offset + concurrency)
          .map((profile) => this.usageService!.refresh(profile.id)),
      );
      synced += results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      failed += results.filter((result) => result.status === "rejected").length;
    }
    return { synced, failed };
  }
}
