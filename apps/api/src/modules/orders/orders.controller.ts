import { RechargesService, rechargeView } from "./recharges.service.js";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  ForbiddenException,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  UserRole,
  createOrderSchema,
  documentRequestSchema,
  travelerSchema,
} from "@visa-compass/shared";
import {
  OrderChannel,
  PaymentStatus,
  SubscriptionStatus,
  UserRoleName,
} from "@prisma/client";
import {
  AccountGuard,
  AccountTypes,
  AuthGuard,
  type AuthenticatedRequest,
  requireRole,
} from "../../common/auth.guard.js";
import { matchesQuery, paginate } from "../../common/paginate.js";
import { OrdersService } from "./orders.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { GuestOrderAccessService } from "./guest-order-access.service.js";
import { TransatelOperationsService } from "../integration/transatel-operations.service.js";
import { UsageService } from "../esims/usage.service.js";
import { AdminService } from "../admin/admin.service.js";

@Controller("customer/orders")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.CUSTOMER)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly guestAccess: GuestOrderAccessService,
    private readonly recharges: RechargesService,
  ) {}
  @Get() list(@Req() req: AuthenticatedRequest) {
    return this.orders.list(req.user!.id);
  }
  @Get(":id") async get(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.orders.refreshOne(id, true);
    if (this.orders.get(id).purchaseType === "TOPUP")
      return rechargeView(await this.recharges.authorize(id, req.user));
    return this.orders.view(id, req.user!.id);
  }
  @Post() async create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = createOrderSchema.parse(body);
    const candidate = body as { mobile?: unknown; lookupToken?: unknown };
    if (candidate.mobile !== undefined && typeof candidate.mobile !== "string")
      throw new BadRequestException("mobile must be a string");
    const verifiedMobile =
      candidate.lookupToken !== undefined
        ? this.guestAccess.mobileFromLookupToken(String(candidate.lookupToken))
        : undefined;
    if (candidate.mobile !== undefined && !verifiedMobile)
      throw new ForbiddenException("A valid top-up lookup is required");
    const ipAddress = (req as { ip?: string }).ip;
    const userAgent = req.headers["user-agent"];
    if (verifiedMobile || input.targetEsimId)
      return this.recharges.create(
        {
          planId: input.planId,
          termsAccepted: input.termsAccepted,
          privacyAccepted: input.privacyAccepted,
          ...(verifiedMobile
            ? { lookupToken: String(candidate.lookupToken) }
            : { targetEsimId: input.targetEsimId }),
          checkoutAttemptKey: String(
            (body as { checkoutAttemptKey?: string }).checkoutAttemptKey ??
              req.headers["x-idempotency-key"] ??
              "",
          ),
        },
        req.user,
        { ipAddress, userAgent },
      );
    return this.orders.create(
      req.user!.id,
      input.planId,
      input.compatibilityAccepted,
      {
        ...(input.targetEsimId ? { targetEsimId: input.targetEsimId } : {}),
        ...(verifiedMobile ? { mobile: verifiedMobile } : {}),
        ...(ipAddress ? { ipAddress } : {}),
        ...(userAgent ? { userAgent } : {}),
        termsAccepted: input.termsAccepted,
        privacyAccepted: input.privacyAccepted,
      },
    );
  }
  @Post(":id/claim-guest")
  async claimGuest(
    @Param("id") id: string,
    @Headers("x-guest-order-token") token: string,
    @Req() req: AuthenticatedRequest,
  ) {
    this.guestAccess.assertSessionToken(id, token);
    const order = await this.orders.claimGuestOrder(
      id,
      req.user!.id,
      req.user!.localUserId,
    );
    await this.guestAccess.revokeAll(id);
    return order;
  }
  @Patch(":id/traveler") traveler(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orders.setTraveler(
      id,
      req.user!.id,
      travelerSchema.parse(body),
    );
  }
  @Post(":id/documents") document(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    const input = documentRequestSchema.parse(body);
    return this.orders.addDocument(id, req.user!.id, input);
  }
  @Post(":id/documents/:documentId/confirm") confirmDocument(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orders.confirmDocument(id, documentId, req.user!.id);
  }
  @Post(":id/verify-passport") verifyPassport(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orders.verifyPassport(id, req.user!.id);
  }
  @Patch(":id/cancel") cancel(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orders.cancel(
      id,
      req.user!.id,
      body.reason ?? "Cancelled by customer",
    );
  }
  @Post(":id/payment/abandon") abandon(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orders.resolvePaymentFailure(
      id,
      req.user!.id,
      body.reason ?? "Payment abandoned by customer",
    );
  }
  @Post(":id/resend-qr") resendQr(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.orders.resendQr(id, req.user!.id);
  }
  @Get(":id/activation-qr") async activationQr(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const { filename, contentType, bytes } = await this.orders.activationQr(
      id,
      req.user!.id,
    );
    response.setHeader("content-type", contentType);
    response.setHeader(
      "content-disposition",
      `attachment; filename="${filename.replace(/["\r\n]/g, "_")}"`,
    );
    response.setHeader("cache-control", "no-store, private");
    response.send(bytes);
  }
}

@Controller("operations")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.OPERATIONS, UserRoleName.SUPER_ADMIN)
export class OperationsController {
  constructor(
    private readonly orders: OrdersService,
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
    private readonly transatelOperations: TransatelOperationsService,
    private readonly usageService: UsageService,
    private readonly admin: AdminService,
  ) {}
  @Get("dashboard") dashboard(@Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const all = this.orders.list();
    const today = new Date().toISOString().slice(0, 10);
    const transatelConfigured = [
      "TRANSATEL_BASE_URL",
      "TRANSATEL_CLIENT_ID",
      "TRANSATEL_CLIENT_SECRET",
      "TRANSATEL_MVNO_REF",
    ].every((key) => Boolean(process.env[key]));
    return {
      counts: {
        reviewPending: all.filter((o) => o.status === "REVIEW_PENDING").length,
        awaitingCustomer: all.filter((o) => o.status === "AWAITING_CUSTOMER")
          .length,
        provisioningFailed: all.filter(
          (o) => o.status === "PROVISIONING_FAILED",
        ).length,
        qrReady: all.filter((o) => o.status === "QR_READY").length,
        activatedToday: all.filter(
          (o) =>
            o.status === "COMPLETED" &&
            o.activatedAt &&
            o.activatedAt.startsWith(today),
        ).length,
        completedToday: all.filter(
          (o) =>
            o.status === "COMPLETED" &&
            (o.activatedAt
              ? o.activatedAt.startsWith(today)
              : o.timeline.some(
                  (event) =>
                    event.to === "COMPLETED" && event.at.startsWith(today),
                )),
        ).length,
        expired: all.filter(
          (o) =>
            o.status === "COMPLETED" &&
            o.plan.validityDays &&
            new Date(
              new Date(o.createdAt).getTime() +
                o.plan.validityDays * 86_400_000,
            ).getTime() < Date.now(),
        ).length,
      },
      integrations: [
        {
          name: "Transatel",
          status: transatelConfigured ? "UP" : "CONFIG_REQUIRED",
        },
        {
          name: "Khalti",
          status: process.env.KHALTI_SECRET_KEY ? "UP" : "CONFIG_REQUIRED",
        },
      ],
      recentOrders: all
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 8),
    };
  }
  @Get("customers") async customers(
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("searchBy") searchBy = "ALL",
    @Query("orderStatus") orderStatus?: string,
    @Query("esimStatus") esimStatus?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) {
      const grouped = new Map<
        string | null,
        ReturnType<OrdersService["list"]>
      >();
      for (const order of this.orders.list())
        grouped.set(order.ownerId, [
          ...(grouped.get(order.ownerId) ?? []),
          order,
        ]);
      const rows = [...grouped.entries()].map(([ownerId, orders]) => {
        const traveler = orders.map((o) => o.traveler).find(Boolean);
        const dates = orders.map((o) => o.createdAt).sort();
        const paid = orders.filter(
          (o) => o.payment?.status === PaymentStatus.COMPLETED,
        );
        return {
          ownerId,
          customerCode: null,
          name: traveler
            ? `${traveler.firstName} ${traveler.surname}`
            : "Customer profile pending",
          email: traveler?.email ?? "—",
          phone: traveler?.mobile ?? null,
          orders: orders.length,
          activeEsims: orders.filter((o) =>
            ["QR_READY", "COMPLETED"].includes(o.status),
          ).length,
          completedEsims: orders.filter((o) => o.status === "COMPLETED").length,
          spendNpr: paid.reduce((sum, o) => sum + o.totalAmountNpr, 0),
          remainingMb: null,
          usageLastCheckedAt: null,
          firstOrderAt: dates[0] ?? null,
          lastOrderAt: dates.at(-1) ?? null,
        };
      });
      return paginate(
        rows.filter((row) =>
          matchesQuery(
            q ?? "",
            row.name,
            row.email,
            row.phone ?? "",
            row.ownerId ?? "",
          ),
        ),
        limit,
        offset,
      );
    }
    const take = Math.min(200, Math.max(1, Number(limit ?? 25) || 25));
    const skip = Math.max(0, Number(offset ?? 0) || 0);
    const search = q?.trim();
    const contains = (value: string) => ({
      contains: value,
      mode: "insensitive" as const,
    });
    const searchMap: Record<string, object[]> = search
      ? {
          NAME: [
            {
              orders: {
                some: {
                  traveler: {
                    is: {
                      OR: [
                        { firstName: contains(search) },
                        { surname: contains(search) },
                      ],
                    },
                  },
                },
              },
            },
          ],
          EMAIL: [
            { email: contains(search) },
            {
              orders: {
                some: { traveler: { is: { email: contains(search) } } },
              },
            },
          ],
          PHONE: [
            { phone: contains(search) },
            {
              orders: {
                some: { traveler: { is: { mobile: contains(search) } } },
              },
            },
          ],
          CUSTOMER_CODE: [{ customerCode: contains(search) }],
          ORDER_NUMBER: [
            { orders: { some: { orderNumber: contains(search) } } },
          ],
        }
      : {};
    const allSearch = Object.values(searchMap).flat();
    const where = {
      AND: [
        ...(search
          ? [
              {
                OR:
                  searchBy === "ALL"
                    ? allSearch
                    : (searchMap[searchBy] ?? allSearch),
              },
            ]
          : []),
        ...(orderStatus
          ? [{ orders: { some: { status: orderStatus as never } } }]
          : []),
        ...(esimStatus
          ? [
              {
                orders: {
                  some: {
                    customerEsim: {
                      is: {
                        subscriptions: {
                          some: { status: esimStatus as never },
                        },
                      },
                    },
                  },
                },
              },
            ]
          : []),
      ],
    };
    const [customers, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        include: {
          user: { select: { clerkId: true } },
          orders: {
            include: {
              traveler: true,
              payments: true,
              customerEsim: { include: { subscriptions: true } },
            },
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.customer.count({ where }),
    ]);
    const items = customers.map((customer) => {
      const traveler = customer.orders.find(
        (order) => order.traveler,
      )?.traveler;
      const displayEmail =
        customer.source === "PARTNER" &&
        customer.email.endsWith("@partner.visacompass.invalid") &&
        traveler?.email
          ? traveler.email
          : customer.email;
      const subscriptions = customer.orders.flatMap(
        (order) => order.customerEsim?.subscriptions ?? [],
      );
      const confirmedUsage = subscriptions.filter(
        (item) =>
          (item.status === SubscriptionStatus.ACTIVE ||
            item.status === SubscriptionStatus.PENDING) &&
          item.assignmentVerificationStatus === "VERIFIED" &&
          item.usageLastCheckedAt,
      );
      const usageCheckedAt = confirmedUsage
        .map((item) => item.usageLastCheckedAt!)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const paidOrders = customer.orders.filter((order) =>
        order.payments.some(
          (payment) => payment.status === PaymentStatus.COMPLETED,
        ),
      );
      return {
        ownerId: customer.user?.clerkId ?? customer.id,
        customerCode: customer.customerCode,
        name: traveler
          ? `${traveler.firstName} ${traveler.surname}`
          : "Customer profile pending",
        email: displayEmail,
        phone: customer.phone ?? traveler?.mobile ?? null,
        orders: customer.orders.length,
        completedEsims: customer.orders.filter(
          (order) => order.status === "COMPLETED",
        ).length,
        activeEsims: subscriptions.filter(
          (item) => item.status === SubscriptionStatus.ACTIVE,
        ).length,
        spendNpr: paidOrders.reduce(
          (sum, order) => sum + Number(order.totalAmount),
          0,
        ),
        remainingMb: confirmedUsage.length
          ? confirmedUsage.reduce(
              (sum, item) => sum + Math.max(0, item.totalMb - item.usedMb),
              0,
            )
          : null,
        usageLastCheckedAt: usageCheckedAt?.toISOString() ?? null,
        usagePartial: confirmedUsage.length < subscriptions.length,
        firstOrderAt: customer.orders.at(-1)?.createdAt.toISOString() ?? null,
        lastOrderAt: customer.orders[0]?.createdAt.toISOString() ?? null,
      };
    });
    return { items, total, limit: take, offset: skip };
  }
  @Get("customers/:ownerId") async customer(
    @Param("ownerId") ownerId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const profile = await this.orders.customerProfile(ownerId);
    const inventoryIds = [
      ...new Set(
        profile.orders
          .map((order) => ("esim" in order ? order.esim?.id : undefined))
          .filter((id: unknown): id is string => typeof id === "string"),
      ),
    ];
    const esimGroups = this.prisma.enabled
      ? await Promise.all(
          inventoryIds.map((inventoryId) =>
            this.usageService.cached(inventoryId),
          ),
        )
      : [];
    return { ...profile, esimGroups };
  }
  @Patch("customers/:ownerId/email") async correctCustomerEmail(
    @Param("ownerId") ownerId: string,
    @Body() body: { email?: string; reason?: string; confirmation?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.SUPER_ADMIN]);
    const confirmation = (body.confirmation ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toUpperCase();
    if (confirmation !== "CHANGE EMAIL")
      throw new BadRequestException('Type "CHANGE EMAIL" to confirm');
    const profile = await this.orders.customerProfile(ownerId);
    const customerId = profile.identity?.customer.id;
    if (!customerId)
      throw new BadRequestException("Customer identity is unavailable");
    return this.admin.correctCustomerEmail(
      customerId,
      body.email ?? "",
      body.reason ?? "",
      req.user!.id,
    );
  }
  @Get("users/:id/identity") async userIdentity(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) return null;
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        status: true,
        accountType: true,
        mustChangePassword: true,
        createdAt: true,
        updatedAt: true,
        customer: {
          select: { id: true, customerCode: true, email: true, status: true },
        },
      },
    });
    if (!user) throw new BadRequestException("Login account not found");
    return user;
  }
  @Post("orders/:id/usage/refresh") refreshUsage(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.inventory.refreshUsage(id);
  }
  @Post("orders/:id/provider-status-check") checkProviderStatus(
    @Param("id") id: string,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!idempotencyKey || !/^[a-zA-Z0-9:_-]{12,128}$/.test(idempotencyKey))
      throw new BadRequestException("A valid idempotency key is required");
    return this.transatelOperations.reconcile(id, req.user!.localUserId);
  }
  @Get("audit") audit(@Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.audit();
  }
  @Get("partners/options") async partnerOptions(
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) return [];
    return this.prisma.partner.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { name: "asc" },
    });
  }
  @Get("orders") async list(
    @Req() req: AuthenticatedRequest,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("source") source?: "DIRECT" | "PARTNER",
    @Query("channel") channel?: OrderChannel,
    @Query("partnerId") partnerId?: string,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    if (!this.prisma.enabled) {
      const filtered = this.orders
        .list()
        .filter(
          (order) =>
            (!status || order.status === status) &&
            matchesQuery(
              q ?? "",
              order.orderNumber,
              order.ownerId,
              order.traveler?.firstName,
              order.traveler?.surname,
              order.traveler?.email,
              order.topUpMobile,
            ),
        );
      return paginate(filtered, limit, offset);
    }
    const take = Math.min(200, Math.max(1, Number(limit ?? 25) || 25));
    const skip = Math.max(0, Number(offset ?? 0) || 0);
    const dateFilter =
      from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {};
    const search = q?.trim();
    const where = {
      ...dateFilter,
      ...(status ? { status: status as never } : {}),
      ...(source === "PARTNER"
        ? { partnerId: { not: null } }
        : source === "DIRECT"
          ? { partnerId: null }
          : {}),
      ...(channel ? { channel } : {}),
      ...(partnerId ? { partnerId } : {}),
      ...(search
        ? {
            OR: [
              {
                orderNumber: { contains: search, mode: "insensitive" as const },
              },
              {
                externalOrderId: {
                  contains: search,
                  mode: "insensitive" as const,
                },
              },
              {
                traveler: {
                  is: {
                    OR: [
                      {
                        firstName: {
                          contains: search,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        surname: {
                          contains: search,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        email: {
                          contains: search,
                          mode: "insensitive" as const,
                        },
                      },
                    ],
                  },
                },
              },
              {
                partner: {
                  is: {
                    OR: [
                      {
                        name: {
                          contains: search,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        code: {
                          contains: search,
                          mode: "insensitive" as const,
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
                        customerCode: {
                          contains: search,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        email: {
                          contains: search,
                          mode: "insensitive" as const,
                        },
                      },
                      {
                        user: {
                          is: {
                            email: {
                              contains: search,
                              mode: "insensitive" as const,
                            },
                          },
                        },
                      },
                      {
                        partnerIdentity: {
                          is: {
                            externalCustomerId: {
                              contains: search,
                              mode: "insensitive" as const,
                            },
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
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          plan: { include: { country: true } },
          traveler: true,
          partner: { select: { id: true, code: true, name: true } },
          customer: {
            select: {
              id: true,
              customerCode: true,
              email: true,
              source: true,
              user: { select: { id: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: rows.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        ownerId: order.customerId,
        customer: {
          id: order.customer.id,
          customerCode: order.customer.customerCode,
          email: order.customer.email,
          source: order.customer.source,
          hasLogin: Boolean(order.customer.user),
        },
        status: order.status,
        createdAt: order.createdAt.toISOString(),
        totalAmountNpr: Number(order.totalAmount),
        plan: {
          name: order.plan.name,
          countryCode: order.plan.country.isoCode,
        },
        traveler: order.traveler
          ? {
              firstName: order.traveler.firstName,
              surname: order.traveler.surname,
              email: order.traveler.email,
            }
          : undefined,
        purchaseType: order.orderType,
        channel: order.channel,
        documentReviewStatus: order.documentReviewStatus,
        externalOrderId: order.externalOrderId,
        partner: order.partner,
      })),
      total,
      limit: take,
      offset: skip,
    };
  }
  @Get("orders/:id") async get(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    await this.orders.refreshOne(id, true);
    const order = await this.orders.operationsView(id);
    const esimUsage = this.prisma.enabled
      ? await this.usageService.forOrder(id)
      : null;
    const paymentHistory = this.prisma.enabled
      ? await this.prisma.paymentEvent.findMany({
          where: { orderId: id },
          orderBy: { createdAt: "desc" },
          take: 100,
          select: {
            id: true,
            provider: true,
            eventType: true,
            source: true,
            paymentReference: true,
            fromStatus: true,
            toStatus: true,
            amount: true,
            currency: true,
            providerTransactionId: true,
            providerMessage: true,
            createdAt: true,
          },
        })
      : [];
    return {
      ...order,
      paymentHistory: paymentHistory.map((event) => ({
        ...event,
        amount: event.amount === null ? null : Number(event.amount),
        createdAt: event.createdAt.toISOString(),
      })),
      ...(esimUsage
        ? {
            packageUsage: this.usageService.packageForOrder(esimUsage, id),
            esimUsage,
          }
        : {}),
    };
  }
  @Get("orders/:id/documents/:documentId/preview") preview(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.documentPreview(id, documentId);
  }
  @Get("orders/:id/documents/:documentId/content") async content(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Req() req: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    const content = await this.orders.documentContent(id, documentId);
    response.setHeader("content-type", content.contentType);
    response.setHeader(
      "content-disposition",
      `inline; filename="${content.fileName.replace(/["\r\n]/g, "_")}"`,
    );
    response.setHeader("cache-control", "no-store, private");
    response.send(content.bytes);
  }
  @Post("orders/:id/approve") approve(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.approve(id, req.user!.id);
  }
  @Post("orders/:id/request-reupload") reupload(
    @Param("id") id: string,
    @Body() body: { reason: string },
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.requestReupload(id, body.reason);
  }
  @Post("orders/:id/reject-documents") rejectDocuments(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.rejectPartnerDocuments(
      id,
      req.user!.id,
      body.reason ?? "",
    );
  }
  @Post("orders/:id/documents/:documentId/approve") approveDocument(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.reviewDocument(id, documentId, req.user!.id, "APPROVE");
  }
  @Post("orders/:id/documents/:documentId/request-reupload") reuploadDocument(
    @Param("id") id: string,
    @Param("documentId") documentId: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.reviewDocument(
      id,
      documentId,
      req.user!.id,
      "REUPLOAD",
      body.reason,
    );
  }
  @Post("orders/:id/retry") retry(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.SUPER_ADMIN]);
    return this.orders.retry(id);
  }
  @Post("orders/:id/resend-qr") resendQr(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.resendQr(id);
  }
  @Post("orders/:id/cancel") cancel(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.cancel(
      id,
      null,
      body.reason ?? "Cancelled by operations",
    );
  }
  @Post("orders/:id/payment/fail") failPayment(
    @Param("id") id: string,
    @Body() body: { reason: string },
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.resolvePaymentFailure(id, null, body.reason);
  }
  @Get("topup/lookup") topUpLookup(
    @Query("mobile") mobile: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.topUpLookup(mobile ?? "", { includeIdentity: true });
  }
  @Post("payments/expire-stale") expireStale(@Req() req: AuthenticatedRequest) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.expireStalePayments();
  }
}
