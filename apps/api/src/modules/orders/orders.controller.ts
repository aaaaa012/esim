import {
  Body,
  Controller,
  Get,
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

@Controller("customer/orders")
@UseGuards(AuthGuard, AccountGuard)
@AccountTypes(UserRoleName.CUSTOMER)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}
  @Get() list(@Req() req: AuthenticatedRequest) {
    return this.orders.list(req.user!.id);
  }
  @Get(":id") get(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.orders.view(id, req.user!.id);
  }
  @Post() create(@Body() body: unknown, @Req() req: AuthenticatedRequest) {
    const input = createOrderSchema.parse(body);
    const ipAddress = (req as { ip?: string }).ip;
    const userAgent = req.headers["user-agent"];
    return this.orders.create(
      req.user!.id,
      input.planId,
      input.compatibilityAccepted,
      {
        ...(input.targetEsimId ? { targetEsimId: input.targetEsimId } : {}),
        ...(ipAddress ? { ipAddress } : {}),
        ...(userAgent ? { userAgent } : {}),
      },
    );
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
      const subscriptions = customer.orders.flatMap(
        (order) => order.customerEsim?.subscriptions ?? [],
      );
      const latestUsage = subscriptions
        .filter((item) => item.usageLastCheckedAt)
        .sort(
          (a, b) =>
            (b.usageLastCheckedAt?.getTime() ?? 0) -
            (a.usageLastCheckedAt?.getTime() ?? 0),
        )[0];
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
        email: customer.email,
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
        remainingMb: latestUsage
          ? Math.max(0, latestUsage.totalMb - latestUsage.usedMb)
          : null,
        usageLastCheckedAt:
          latestUsage?.usageLastCheckedAt?.toISOString() ?? null,
        firstOrderAt: customer.orders.at(-1)?.createdAt.toISOString() ?? null,
        lastOrderAt: customer.orders[0]?.createdAt.toISOString() ?? null,
      };
    });
    return { items, total, limit: take, offset: skip };
  }
  @Get("customers/:ownerId") customer(
    @Param("ownerId") ownerId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.orders.customerProfile(ownerId);
  }
  @Post("orders/:id/usage/refresh") refreshUsage(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
    return this.inventory.refreshUsage(id);
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
    await this.orders.refreshOne(id);
    return this.orders.view(id);
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
    requireRole(req, [UserRole.OPERATIONS, UserRole.SUPER_ADMIN]);
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
