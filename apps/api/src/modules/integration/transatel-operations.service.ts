import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  InventoryStatus,
  Prisma,
  SubscriptionStatus,
  TransatelLifecycleAction,
  TransatelLifecycleState,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ConnectivityService } from "./connectivity.service.js";
import { OrdersService } from "../orders/orders.service.js";

type LifecycleInput = {
  orderId: string;
  action: TransatelLifecycleAction;
  reason: string;
  idempotencyKey: string;
  actorId: string;
};

@Injectable()
export class TransatelOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly orders: OrdersService,
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
        providerStatus:
          subscription.customerEsim.order.providerStatus ??
          subscription.customerEsim.inventory.providerStatus,
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
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        inventory: true,
        customerEsim: { include: { subscriptions: true } },
        transatelLifecycleOperations: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (!order?.inventory)
      throw new NotFoundException("The order does not have an assigned eSIM");
    const details = await this.connectivity.getEsimDetails(
      order.inventory.iccid,
    );
    const observedProfileStatus = details.status.toUpperCase();
    const usage = await this.connectivity
      .getUsage(order.inventory.iccid)
      .catch(() => null);
    const providerSubscription = usage?.subscriptions?.find(
      (subscription) =>
        !order.providerSubscriptionId ||
        subscription.providerSubscriptionId === order.providerSubscriptionId,
    );
    const observedSubscriptionStatus =
      providerSubscription?.status.toUpperCase() ?? null;
    const activationConfirmed = observedSubscriptionStatus === "ACTIVE";
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
                  status: "ACTIVE",
                  providerLastSeenAt: checkedAt,
                  ...(usage?.usageAvailable !== false
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
        orderId,
        esimProfileStatus: observedProfileStatus,
        subscriptionStatus: observedSubscriptionStatus,
        usageAvailable: Boolean(usage) && usage?.usageAvailable !== false,
        operationState: null,
        checkedAt: checkedAt.toISOString(),
      };
    }
    const latest = order.transatelLifecycleOperations[0];
    const confirmed =
      latest &&
      ((latest.action === TransatelLifecycleAction.SUSPEND &&
        observedSubscriptionStatus === "SUSPENDED") ||
        (latest.action === TransatelLifecycleAction.TERMINATE &&
          observedSubscriptionStatus === "TERMINATED"));
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          ...(observedSubscriptionStatus
            ? { providerStatus: observedSubscriptionStatus }
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
          ...(observedProfileStatus === "DELETED"
            ? { status: "TERMINATED" }
            : {}),
          version: { increment: 1 },
        },
      });
      if (order.customerEsim && providerSubscription) {
        const subscriptionStatus =
          observedSubscriptionStatus === "SUSPENDED"
            ? ("SUSPENDED" as const)
            : observedSubscriptionStatus === "TERMINATED"
              ? ("TERMINATED" as const)
              : observedSubscriptionStatus === "ACTIVE"
                ? ("ACTIVE" as const)
                : observedSubscriptionStatus
                  ? ("PENDING" as const)
                  : null;
        await tx.subscription.updateMany({
          where: {
            customerEsimId: order.customerEsim.id,
            providerSubscriptionId: providerSubscription.providerSubscriptionId,
          },
          data: {
            ...(subscriptionStatus ? { status: subscriptionStatus } : {}),
            providerLastSeenAt: checkedAt,
            ...(usage?.usageAvailable !== false
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
              observedSubscriptionStatus,
              checkedAt: checkedAt.toISOString(),
            },
          },
        });
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
            subscriptionStatus: observedSubscriptionStatus,
            operationId: latest?.id ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    });
    return {
      orderId,
      esimProfileStatus: observedProfileStatus,
      subscriptionStatus: observedSubscriptionStatus,
      usageAvailable: Boolean(usage) && usage?.usageAvailable !== false,
      operationState: confirmed
        ? TransatelLifecycleState.CONFIRMED
        : (latest?.state ?? null),
      checkedAt: checkedAt.toISOString(),
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
    if (
      order.inventory.status === "TERMINATED" ||
      order.providerStatus === "TERMINATED"
    ) {
      if (input.action === TransatelLifecycleAction.TERMINATE)
        throw new ConflictException("This eSIM is already terminated");
      throw new ConflictException("A terminated eSIM cannot be suspended");
    }
    const lifecycleStatus = (
      order.providerStatus ??
      order.inventory.providerStatus ??
      order.inventory.status
    ).toUpperCase();
    if (
      input.action === TransatelLifecycleAction.SUSPEND &&
      !["ACTIVE", "ACTIVATED"].includes(lifecycleStatus)
    )
      throw new ConflictException(
        `Only an active eSIM can be suspended (current provider state: ${lifecycleStatus})`,
      );
    if (
      input.action === TransatelLifecycleAction.TERMINATE &&
      !["ACTIVE", "ACTIVATED", "SUSPENDED"].includes(lifecycleStatus)
    )
      throw new ConflictException(
        `This eSIM cannot be terminated from provider state ${lifecycleStatus}`,
      );
    if (
      input.action === TransatelLifecycleAction.SUSPEND &&
      ["SUSPENDED", "SUSPEND_PENDING"].includes(order.providerStatus ?? "")
    )
      throw new ConflictException(
        "This eSIM is already suspended or suspension is pending",
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
      throw new ConflictException(
        `A ${input.action.toLowerCase()} operation is already pending provider confirmation`,
      );
    if (inFlight) return inFlight;
    const reference =
      order.inventory.providerSubscriptionId ??
      order.providerSubscriptionId ??
      order.inventory.iccid;
    const requestSnapshot = {
      orderId: order.id,
      iccid: order.inventory.iccid,
      providerSubscriptionId: reference,
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
}
