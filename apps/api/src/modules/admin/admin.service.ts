import {
  BadRequestException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  DocumentReviewPolicy,
  PlanStatus,
  StaffInvitationStatus,
  SubscriptionStatus,
  UserRoleName,
  UserStatus,
  Prisma,
} from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import {
  isRestrictedPlanCountry,
  RESTRICTED_PLAN_COUNTRY_CODES,
} from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ApiException } from "../../common/api-error.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { createClerkClient } from "@clerk/backend";
import { tabularToRecords } from "../../common/tabular.util.js";
import { KhaltiGateway } from "../payments/gateways/khalti.gateway.js";
import {
  EMAIL_CHANNEL,
  type EmailChannel,
} from "../notification/email.channel.js";

type ClerkActivationFailure = {
  code: string;
  message: string;
  providerCodes: string[];
  status: number | undefined;
};

export function mapClerkActivationFailure(
  error: unknown,
): ClerkActivationFailure {
  const value =
    error && typeof error === "object"
      ? (error as {
          status?: unknown;
          statusCode?: unknown;
          errors?: Array<{ code?: unknown }>;
        })
      : undefined;
  const rawStatus = value?.status ?? value?.statusCode;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const providerCodes = Array.isArray(value?.errors)
    ? value.errors
        .map((item) =>
          typeof item?.code === "string" ? item.code.toLowerCase() : "",
        )
        .filter(Boolean)
    : [];
  const joinedCodes = providerCodes.join(" ");

  if (
    /identifier.*(exists|taken)|email.*(exists|taken)|already.*(exists|registered)/.test(
      joinedCodes,
    )
  ) {
    return {
      code: "CLERK_IDENTITY_EXISTS",
      message:
        "A Clerk account already exists for this email in the configured Clerk instance. Delete that Clerk user or use a different email, then try again.",
      providerCodes,
      status,
    };
  }
  if (/password|pwned|breach/.test(joinedCodes)) {
    return {
      code: "CLERK_PASSWORD_REJECTED",
      message:
        "Clerk rejected this password. Choose a different strong password that meets the configured password policy.",
      providerCodes,
      status,
    };
  }
  if (status === HttpStatus.TOO_MANY_REQUESTS || /rate.*limit/.test(joinedCodes)) {
    return {
      code: "CLERK_RATE_LIMITED",
      message: "Too many activation attempts. Wait a few minutes and try again.",
      providerCodes,
      status,
    };
  }
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
    return {
      code: "CLERK_CONFIGURATION_ERROR",
      message:
        "The staff identity service rejected the server credentials. Contact support to verify the Clerk environment configuration.",
      providerCodes,
      status,
    };
  }
  return {
    code: "CLERK_ACTIVATION_FAILED",
    message:
      "Unable to activate this staff account. Contact support with the request correlation ID.",
    providerCodes,
    status,
  };
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectivity: ConnectivityService,
    private readonly khalti: KhaltiGateway = new KhaltiGateway(),
    @Optional() @Inject(EMAIL_CHANNEL) private readonly email?: EmailChannel,
  ) {}

  async documentReviewPolicy() {
    if (!this.prisma.enabled)
      return { policy: DocumentReviewPolicy.AUTO_OCR, ocrCheckoutWaitMs: 8000 };
    const config = await this.prisma.platformConfiguration.upsert({
      where: { id: "platform" },
      update: {},
      create: { id: "platform" },
    });
    return {
      policy: config.documentReviewPolicy,
      ocrCheckoutWaitMs: config.ocrCheckoutWaitMs,
      updatedAt: config.updatedAt,
    };
  }

  async updateDocumentReviewPolicy(
    input: { policy: DocumentReviewPolicy; ocrCheckoutWaitMs?: number },
    actorClerkId: string,
  ) {
    if (!Object.values(DocumentReviewPolicy).includes(input.policy))
      throw new BadRequestException("Invalid document review policy");
    const waitMs = input.ocrCheckoutWaitMs ?? 8000;
    if (!Number.isInteger(waitMs) || waitMs < 1000 || waitMs > 30000)
      throw new BadRequestException(
        "OCR checkout wait must be between 1 and 30 seconds",
      );
    const actor = await this.actor(actorClerkId);
    const previous = await this.prisma.platformConfiguration.upsert({
      where: { id: "platform" },
      update: {},
      create: { id: "platform" },
    });
    const updated = await this.prisma.platformConfiguration.update({
      where: { id: "platform" },
      data: {
        documentReviewPolicy: input.policy,
        ocrCheckoutWaitMs: waitMs,
        updatedById: actor?.id ?? null,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        module: "DOCUMENT_RULES",
        entity: "PlatformConfiguration",
        entityId: updated.id,
        action: "DOCUMENT_REVIEW_POLICY_CHANGED",
        ...(actor ? { performedById: actor.id } : {}),
        previousValue: {
          policy: previous.documentReviewPolicy,
          ocrCheckoutWaitMs: previous.ocrCheckoutWaitMs,
        },
        newValue: {
          policy: updated.documentReviewPolicy,
          ocrCheckoutWaitMs: updated.ocrCheckoutWaitMs,
        },
      },
    });
    return {
      policy: updated.documentReviewPolicy,
      ocrCheckoutWaitMs: updated.ocrCheckoutWaitMs,
      updatedAt: updated.updatedAt,
    };
  }

  async plans() {
    if (!this.prisma.enabled) return [];
    return this.prisma.plan
      .findMany({
        where: {
          country: { isoCode: { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] } },
        },
        include: { country: true },
        orderBy: [{ country: { name: "asc" } }, { sellingPrice: "asc" }],
      })
      .then((rows) =>
        rows.map((plan) => ({
          id: plan.id,
          name: plan.name,
          countryCode: plan.country.isoCode,
          countryName: plan.country.name,
          dataAllowance: plan.dataAllowance,
          validityDays: plan.validityDays,
          sellingPriceNpr: Number(plan.sellingPrice),
          costPriceNpr: Number(plan.costPrice),
          currency: plan.currency,
          popular: plan.popular,
          status: plan.status,
        })),
      );
  }

  async planPage(input: {
    q?: string;
    status?: PlanStatus;
    limit?: number;
    offset?: number;
  }) {
    if (!this.prisma.enabled)
      return { items: [], total: 0, limit: 50, offset: 0 };
    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(input.limit) ? input.limit! : 50),
    );
    const offset = Math.max(
      0,
      Number.isFinite(input.offset) ? input.offset! : 0,
    );
    const query = input.q?.trim();
    const where: Prisma.PlanWhereInput = {
      country: { isoCode: { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] } },
      ...(input.status ? { status: input.status } : {}),
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { providerPlanId: { contains: query, mode: "insensitive" } },
              { country: { name: { contains: query, mode: "insensitive" } } },
              { country: { isoCode: { equals: query.toUpperCase() } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.plan.findMany({
        where,
        select: {
          id: true,
          name: true,
          dataAllowance: true,
          validityDays: true,
          sellingPrice: true,
          costPrice: true,
          currency: true,
          popular: true,
          status: true,
          country: { select: { isoCode: true, name: true } },
        },
        orderBy: [
          { country: { name: "asc" } },
          { sellingPrice: "asc" },
          { id: "asc" },
        ],
        take: limit,
        skip: offset,
      }),
      this.prisma.plan.count({ where }),
    ]);
    return {
      items: rows.map((plan) => ({
        id: plan.id,
        name: plan.name,
        countryCode: plan.country.isoCode,
        countryName: plan.country.name,
        dataAllowance: plan.dataAllowance,
        validityDays: plan.validityDays,
        sellingPriceNpr: Number(plan.sellingPrice),
        costPriceNpr: Number(plan.costPrice),
        currency: plan.currency,
        popular: plan.popular,
        status: plan.status,
      })),
      total,
      limit,
      offset,
    };
  }

  async updatePlan(
    id: string,
    input: { sellingPriceNpr?: number; popular?: boolean; status?: PlanStatus },
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    if (
      input.sellingPriceNpr !== undefined &&
      (!Number.isFinite(input.sellingPriceNpr) || input.sellingPriceNpr < 0)
    )
      throw new BadRequestException("Selling price must be a positive number");
    const exists = await this.prisma.plan.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException("Plan not found");
    await this.prisma.plan.update({
      where: { id },
      data: {
        ...(input.sellingPriceNpr !== undefined
          ? { sellingPrice: input.sellingPriceNpr }
          : {}),
        ...(input.popular !== undefined ? { popular: input.popular } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    });
    return (await this.plans()).find((plan) => plan.id === id);
  }

  /**
   * Approves a plan so it becomes visible in the customer catalogue. Only
   * DRAFT (imported-but-unreviewed) plans may be approved; the decision is
   * audited.
   */
  async approvePlan(id: string, actorClerkId: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: { country: true },
    });
    if (!plan) throw new NotFoundException("Plan not found");
    if (plan.status !== PlanStatus.DRAFT)
      throw new BadRequestException(
        `Plan is ${plan.status.toLowerCase()}; only draft plans can be approved`,
      );
    if (isRestrictedPlanCountry(plan.country.isoCode))
      throw new BadRequestException(
        `Plans for destination country ${plan.country.isoCode} are not supported`,
      );
    const actor = await this.actor(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.plan.update({
        where: { id },
        data: { status: PlanStatus.ACTIVE },
      });
      await tx.auditLog.create({
        data: {
          module: "PLAN_ADMIN",
          entity: "Plan",
          entityId: id,
          action: "PLAN_APPROVED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { status: plan.status },
          newValue: { status: PlanStatus.ACTIVE },
        },
      });
    });
    return (await this.plans()).find((item) => item.id === id);
  }

  async rejectPlan(id: string, actorClerkId: string, reason?: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException("Plan not found");
    if (plan.status === PlanStatus.ACTIVE)
      throw new BadRequestException(
        "An active plan cannot be rejected; disable it instead",
      );
    const actor = await this.actor(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.plan.update({
        where: { id },
        data: { status: PlanStatus.ARCHIVED },
      });
      await tx.auditLog.create({
        data: {
          module: "PLAN_ADMIN",
          entity: "Plan",
          entityId: id,
          action: "PLAN_REJECTED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { status: plan.status },
          newValue: {
            status: PlanStatus.ARCHIVED,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          },
        },
      });
    });
    return (await this.plans()).find((item) => item.id === id);
  }

  private async actor(actorClerkId: string) {
    try {
      return await this.prisma.user.findUnique({
        where: { clerkId: actorClerkId },
      });
    } catch {
      return null;
    }
  }

  async importPlansFromTabular(
    content: string,
    fileName?: string,
    actorClerkId?: string,
    mode: "UPDATE_LISTED" = "UPDATE_LISTED",
  ) {
    if (mode !== "UPDATE_LISTED")
      throw new BadRequestException("Unsupported plan import mode");
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const actor = actorClerkId ? await this.actor(actorClerkId) : null;
    // Super admins import straight to ACTIVE (final); operators land as DRAFT
    // for review and approval by a super admin.
    const roleDefaultStatus: PlanStatus =
      actor?.accountType === UserRoleName.SUPER_ADMIN
        ? PlanStatus.ACTIVE
        : PlanStatus.DRAFT;
    const { records, errors } = await tabularToRecords(
      content,
      [
        "countryiso2",
        "name",
        "providerplanid",
        "dataallowance",
        "validitydays",
        "costprice",
        "sellingprice",
      ],
      fileName ? { fileName, maxRows: 10000 } : { maxRows: 10000 },
    );
    if (errors.length) throw new BadRequestException(errors.join("; "));
    const rowErrors: string[] = [];
    let imported = 0;
    let updated = 0;
    for (const [index, row] of records.entries()) {
      const line = index + 2;
      const countryIso2 = (row.countryiso2 ?? "").trim().toUpperCase();
      const name = (row.name ?? "").trim();
      const providerPlanId = (row.providerplanid ?? "").trim();
      const dataAllowance = (row.dataallowance ?? "").trim();
      const validityDays = this.parseValidityToDays(row.validitydays);
      const sellingPrice = Number(row.sellingprice);
      const rawCost = (row.costprice ?? "").toString().trim();
      const parsedCost = rawCost ? Number(rawCost) : NaN;
      // costPrice is optional; when omitted it defaults to the selling price.
      const costPrice =
        Number.isFinite(parsedCost) && parsedCost >= 0
          ? parsedCost
          : sellingPrice;
      const currency = (row.currency ?? "NPR").trim().toUpperCase();
      const popularRaw = (row.popular ?? "").trim().toLowerCase();
      const popular = popularRaw
        ? popularRaw === "true" || popularRaw === "1"
        : undefined;
      const statusRaw = (row.status ?? "").trim().toUpperCase();
      const requestedStatus = Object.values(PlanStatus).includes(
        statusRaw as PlanStatus,
      )
        ? (statusRaw as PlanStatus)
        : undefined;
      const coverageCountries = (row.coveragecountries ?? "")
        .split(/[|;]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!/^[A-Z]{2}$/.test(countryIso2)) {
        rowErrors.push(
          `Line ${line}: invalid countryIso2 '${countryIso2 || "(empty)"}'`,
        );
        continue;
      }
      if (statusRaw && !requestedStatus) {
        rowErrors.push(
          `Line ${line}: status must be ACTIVE, DRAFT, DISABLED, or ARCHIVED`,
        );
        continue;
      }
      if (popularRaw && !["true", "false", "1", "0"].includes(popularRaw)) {
        rowErrors.push(`Line ${line}: popular must be true, false, 1, or 0`);
        continue;
      }
      if (isRestrictedPlanCountry(countryIso2)) {
        rowErrors.push(
          `Line ${line}: destination country '${countryIso2}' is not supported`,
        );
        continue;
      }
      if (!name) {
        rowErrors.push(`Line ${line}: name is required`);
        continue;
      }
      if (!providerPlanId) {
        rowErrors.push(`Line ${line}: providerPlanId is required`);
        continue;
      }
      if (!dataAllowance) {
        rowErrors.push(`Line ${line}: dataAllowance is required`);
        continue;
      }
      if (
        validityDays === null ||
        !Number.isInteger(validityDays) ||
        validityDays < 1 ||
        validityDays > 3650
      ) {
        rowErrors.push(
          `Line ${line}: validityDays must be a whole number between 1 and 3650`,
        );
        continue;
      }
      if (
        !Number.isFinite(costPrice) ||
        costPrice < 0 ||
        costPrice > 9999999999.99
      ) {
        rowErrors.push(`Line ${line}: costPrice must be a non-negative number`);
        continue;
      }
      if (
        !Number.isFinite(sellingPrice) ||
        sellingPrice < 0 ||
        sellingPrice > 9999999999.99
      ) {
        rowErrors.push(
          `Line ${line}: sellingPrice must be a non-negative number`,
        );
        continue;
      }
      try {
        const country = await this.prisma.country.upsert({
          where: { isoCode: countryIso2 },
          update: {
            name: (row.countryname ?? "").trim() || countryIso2,
            active: true,
          },
          create: {
            isoCode: countryIso2,
            name: (row.countryname ?? "").trim() || countryIso2,
            active: true,
          },
        });
        const existing = await this.prisma.plan.findUnique({
          where: {
            countryId_providerPlanId: {
              countryId: country.id,
              providerPlanId,
            },
          },
        });
        const coverage = coverageCountries.length
          ? coverageCountries
          : [country.name];
        const data = {
          name,
          dataAllowance,
          validityDays,
          costPrice,
          sellingPrice,
          currency,
          coverage,
        };
        if (existing) {
          // Operators may retain an already-active plan, but only a super
          // admin may promote a draft/disabled plan to ACTIVE.
          const effectiveStatus =
            requestedStatus === PlanStatus.ACTIVE &&
            actor?.accountType !== UserRoleName.SUPER_ADMIN &&
            existing.status !== PlanStatus.ACTIVE
              ? existing.status
              : (requestedStatus ?? existing.status);
          await this.prisma.plan.update({
            where: { id: existing.id },
            data: {
              ...data,
              status: effectiveStatus,
              ...(popular !== undefined ? { popular } : {}),
            },
          });
          updated++;
        } else {
          await this.prisma.plan.create({
            data: {
              countryId: country.id,
              providerPlanId,
              ...data,
              popular: popular ?? false,
              status:
                requestedStatus === PlanStatus.ACTIVE &&
                actor?.accountType !== UserRoleName.SUPER_ADMIN
                  ? PlanStatus.DRAFT
                  : (requestedStatus ?? roleDefaultStatus),
            },
          });
          imported++;
        }
      } catch (error) {
        rowErrors.push(
          `Line ${line}: ${error instanceof Error ? error.message : "failed to persist"}`,
        );
      }
    }
    const summary = {
      mode,
      imported,
      updated,
      skipped: rowErrors.length,
      errors: rowErrors.slice(0, 100),
    };
    if (this.prisma.enabled && actorClerkId) {
      await this.prisma.auditLog.create({
        data: {
          module: "PLAN_ADMIN",
          entity: "PlanImport",
          entityId: `import-${Date.now()}`,
          action: "PLANS_IMPORTED",
          ...(actor ? { performedById: actor.id } : {}),
          newValue: {
            imported,
            updated,
            skipped: rowErrors.length,
            fileName: fileName ?? null,
            mode,
          },
        },
      });
    }
    return summary;
  }

  /**
   * Parses a plan validity value to a whole number of days.
   *
   * Accepts plain integers ("7") or human-readable forms ("7 days", "7days",
   * "7D", "1 months", "2 month"). Validity is counted from the day the plan is
   * activated: a value of "7 days" means 7 days after the activation date.
   * Returns null when the value cannot be interpreted.
   */
  private parseValidityToDays(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const match = raw.match(/^(\d+)\s*(day|days|d|month|months|mo)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isInteger(amount) || amount < 1) return null;
    const unit = (match[2] ?? "day").toLowerCase();
    if (unit === "month" || unit === "months" || unit === "mo")
      return amount * 30;
    return amount;
  }

  integrations() {
    const configured = (keys: string[]) =>
      keys.every((key) => Boolean(process.env[key]));
    return [
      {
        id: "email",
        name: "Email (AWS SES)",
        category: "NOTIFICATION",
        provider: "AWS_SES",
        enabled:
          process.env.NOTIFICATION_MODE === "live" &&
          process.env.EMAIL_PROVIDER === "ses" &&
          Boolean(process.env.AWS_SES_REGION || process.env.AWS_REGION) &&
          configured(["EMAIL_FROM_ADDRESS"]),
        status:
          process.env.NOTIFICATION_MODE === "live" &&
          process.env.EMAIL_PROVIDER === "ses" &&
          Boolean(process.env.AWS_SES_REGION || process.env.AWS_REGION) &&
          configured(["EMAIL_FROM_ADDRESS"])
            ? "HEALTHY"
            : "SIMULATED",
      },
      {
        id: "khalti",
        name: "Khalti Payment Gateway",
        category: "PAYMENT",
        provider: "KHALTI",
        enabled: configured(["KHALTI_SECRET_KEY"]),
        status: configured(["KHALTI_SECRET_KEY"])
          ? "HEALTHY"
          : "CONFIG_REQUIRED",
      },
      {
        id: "transatel",
        name: "Transatel Connectivity",
        category: "CONNECTIVITY",
        provider: "TRANSATEL",
        enabled: configured([
          "TRANSATEL_BASE_URL",
          "TRANSATEL_CLIENT_ID",
          "TRANSATEL_CLIENT_SECRET",
          "TRANSATEL_MVNO_REF",
        ]),
        status: configured([
          "TRANSATEL_BASE_URL",
          "TRANSATEL_CLIENT_ID",
          "TRANSATEL_CLIENT_SECRET",
          "TRANSATEL_MVNO_REF",
        ])
          ? "HEALTHY"
          : "CONFIG_REQUIRED",
      },
      {
        id: "s3",
        name: "Private Document Storage",
        category: "STORAGE",
        provider: "AWS_S3",
        enabled: configured(["AWS_REGION", "AWS_S3_BUCKET"]),
        status: configured(["AWS_REGION", "AWS_S3_BUCKET"])
          ? "HEALTHY"
          : "CONFIG_REQUIRED",
      },
      {
        id: "whatsapp",
        name: "WhatsApp Business",
        category: "NOTIFICATION",
        provider: "WHATSAPP",
        enabled:
          process.env.NOTIFICATION_MODE === "live" &&
          configured([
            "WHATSAPP_API_URL",
            "WHATSAPP_ACCESS_TOKEN",
            "WHATSAPP_PHONE_NUMBER_ID",
          ]),
        status:
          process.env.NOTIFICATION_MODE === "live" &&
          configured([
            "WHATSAPP_API_URL",
            "WHATSAPP_ACCESS_TOKEN",
            "WHATSAPP_PHONE_NUMBER_ID",
          ])
            ? "HEALTHY"
            : "SIMULATED",
      },
    ].map((item) => ({
      ...item,
      secretValue: item.enabled ? "•••••••• configured" : "Not configured",
      checkedAt: new Date().toISOString(),
    }));
  }

  async testIntegration(id: string) {
    const item = this.integrations().find(
      (integration) => integration.id === id,
    );
    if (!item) throw new NotFoundException("Integration not found");
    if (id === "khalti") {
      const diagnostic = await this.khalti.diagnose();
      return {
        id,
        status: "HEALTHY",
        checkedAt: new Date().toISOString(),
        message: `${diagnostic.message} Environment: ${diagnostic.environment}.`,
        diagnostic: {
          environment: diagnostic.environment,
          providerStatus: diagnostic.providerStatus,
        },
      };
    }
    return {
      id,
      status: item.enabled ? "HEALTHY" : "CONFIG_REQUIRED",
      checkedAt: new Date().toISOString(),
      message: item.enabled
        ? `${item.name} configuration is available`
        : `${item.name} requires environment configuration`,
    };
  }

  private requireTransatel() {
    const required = [
      "TRANSATEL_BASE_URL",
      "TRANSATEL_CLIENT_ID",
      "TRANSATEL_CLIENT_SECRET",
      "TRANSATEL_MVNO_REF",
    ];
    if (!required.every((key) => Boolean(process.env[key])))
      throw new BadRequestException(
        "Transatel is not configured; set the Transatel environment variables first",
      );
  }

  async syncTransatelCatalog() {
    this.requireTransatel();
    return this.connectivity.syncCatalog();
  }

  async syncTransatelUsage() {
    this.requireTransatel();
    if (!this.prisma.enabled) return { synced: 0, failed: 0 };
    const subscriptions = await this.prisma.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE },
      select: {
        id: true,
        customerEsim: { select: { inventory: { select: { iccid: true } } } },
      },
      take: 200,
    });
    let synced = 0;
    let failed = 0;
    for (const sub of subscriptions) {
      const iccid = sub.customerEsim?.inventory?.iccid;
      if (!iccid) continue;
      try {
        await this.connectivity.getUsage(iccid);
        synced += 1;
      } catch {
        failed += 1;
      }
    }
    return { synced, failed };
  }

  /** Exports the current operating catalogue as a lossless import template. */
  async exportTransatelCatalog(_cos?: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const plans = await this.prisma.plan.findMany({
      include: { country: true },
      orderBy: [{ country: { isoCode: "asc" } }, { providerPlanId: "asc" }],
    });
    const columns = [
      "countryiso2",
      "countryname",
      "name",
      "providerplanid",
      "dataallowance",
      "validitydays",
      "costprice",
      "sellingprice",
      "currency",
      "coveragecountries",
      "popular",
      "status",
    ] as const;
    const renderRow = (row: Record<string, unknown>) =>
      columns.map((column) => this.csvCell(row[column])).join(",");
    const csv = [
      columns.join(","),
      ...plans.map((plan) =>
        renderRow({
          countryiso2: plan.country.isoCode,
          countryname: plan.country.name,
          name: plan.name,
          providerplanid: plan.providerPlanId,
          dataallowance: plan.dataAllowance,
          validitydays: plan.validityDays,
          costprice: plan.costPrice,
          sellingprice: plan.sellingPrice,
          currency: plan.currency,
          coveragecountries: Array.isArray(plan.coverage)
            ? plan.coverage.join("|")
            : "",
          popular: plan.popular,
          status: plan.status,
        }),
      ),
    ].join("\n");
    return {
      fileName: `visa-compass-catalog-${new Date().toISOString().slice(0, 10)}.csv`,
      count: plans.length,
      skipped: 0,
      skippedIds: [],
      csv,
    };
  }

  private csvCell(value: unknown): string {
    const raw = String(value ?? "");
    if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
    return raw;
  }

  async ensureTransatelWebhook() {
    this.requireTransatel();
    return this.connectivity.ensureWebhook();
  }

  async transatelEligibility(planId: string, msisdn: string) {
    this.requireTransatel();
    if (!/^\d{6,15}$/.test(msisdn))
      throw new BadRequestException("A valid subscriber MSISDN is required");
    return this.connectivity.checkEligibility(planId, msisdn);
  }

  async users(
    input: {
      q?: string;
      accountType?: UserRoleName;
      status?: UserStatus;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    if (!this.prisma.enabled)
      return { items: [], total: 0, limit: 50, offset: 0 };
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    const where = {
      ...(input.q?.trim()
        ? {
            OR: [
              {
                email: {
                  contains: input.q.trim(),
                  mode: "insensitive" as const,
                },
              },
              {
                clerkId: {
                  contains: input.q.trim(),
                  mode: "insensitive" as const,
                },
              },
              {
                customer: {
                  is: {
                    customerCode: {
                      contains: input.q.trim(),
                      mode: "insensitive" as const,
                    },
                  },
                },
              },
            ],
          }
        : {}),
      ...(input.accountType ? { accountType: input.accountType } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { roles: { include: { role: true } }, customer: true },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count({ where }),
    ]);
    const items = users.map((user) => ({
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      status: user.status,
      accountType: user.accountType,
      effectiveCapabilities:
        user.accountType === UserRoleName.CUSTOMER
          ? ["customer:portal", "customer:orders"]
          : user.accountType === UserRoleName.OPERATIONS
            ? ["operations:portal", "operations:review", "operations:inventory"]
            : [
                "operations:portal",
                "operations:review",
                "operations:inventory",
                "admin:portal",
                "admin:users",
                "admin:configuration",
              ],
      customerCode: user.customer?.customerCode,
      createdAt: user.createdAt,
    }));
    return { items, total, limit, offset };
  }

  async invitations() {
    if (!this.prisma.enabled) return [];
    return this.prisma.staffInvitation.findMany({
      include: { invitedBy: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    });
  }
  private staffDomain(): string {
    return process.env.STAFF_EMAIL_DOMAIN ?? "visacompassnepal.com";
  }
  async invite(
    emailInput: string,
    accountType: UserRoleName,
    inviterId: string,
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    if (
      accountType !== UserRoleName.OPERATIONS &&
      accountType !== UserRoleName.SUPER_ADMIN
    )
      throw new BadRequestException("Staff account type is required");
    const email = emailInput.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email))
      throw new BadRequestException("Valid email is required");
    const domain = this.staffDomain();
    if (!email.endsWith(`@${domain}`))
      throw new BadRequestException(
        `Staff accounts must use a company email at @${domain}`,
      );
    if (await this.prisma.user.findUnique({ where: { email } }))
      throw new BadRequestException(
        "This email already belongs to an account; staff and customer identities must be separate",
      );
    if (
      await this.prisma.staffInvitation.findFirst({
        where: {
          email,
          status: StaffInvitationStatus.PENDING,
          expiresAt: { gt: new Date() },
        },
      })
    )
      throw new BadRequestException("An active invitation already exists");
    const inviter = await this.prisma.user.findUnique({
      where: { clerkId: inviterId },
    });
    if (!inviter) throw new NotFoundException("Inviter account not found");
    if (!process.env.CLERK_SECRET_KEY)
      throw new BadRequestException("Clerk is not configured");
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
    const activationToken = randomBytes(32).toString("base64url");
    const invitation = await this.prisma.staffInvitation.create({
      data: {
        email,
        accountType,
        invitedById: inviter.id,
        expiresAt,
        activationTokenHash: this.activationTokenHash(activationToken),
      },
    });
    try {
      await this.sendActivationEmail({
        invitationId: invitation.id,
        email,
        accountType,
        expiresAt,
        activationToken,
        inviterEmail: inviter.email,
      });
    } catch (error) {
      await this.prisma.staffInvitation.update({
        where: { id: invitation.id },
        data: {
          status: StaffInvitationStatus.REVOKED,
          revokedAt: new Date(),
        },
      });
      throw error;
    }
    await this.audit(inviter.id, "StaffInvitation", invitation.id, "CREATED", {
      email,
      accountType,
    });
    return { ...invitation, delivery: "SENT" as const };
  }
  async revokeInvitation(id: string, actorClerkId: string) {
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { id },
    });
    if (!invitation) throw new NotFoundException("Invitation not found");
    if (invitation.status !== StaffInvitationStatus.PENDING)
      throw new BadRequestException("Invitation is not pending");
    const actor = await this.prisma.user.findUnique({
      where: { clerkId: actorClerkId },
    });
    if (invitation.clerkInvitationId && process.env.CLERK_SECRET_KEY) {
      try {
        await createClerkClient({
          secretKey: process.env.CLERK_SECRET_KEY,
        }).users.deleteUser(invitation.clerkInvitationId);
      } catch {}
    }
    const updated = await this.prisma.staffInvitation.update({
      where: { id },
      data: { status: StaffInvitationStatus.REVOKED, revokedAt: new Date() },
    });
    await this.audit(actor?.id, "StaffInvitation", id, "REVOKED", null);
    return updated;
  }
  async resendInvitation(id: string, actorClerkId: string) {
    const old = await this.prisma.staffInvitation.findUnique({
      where: { id },
      include: { invitedBy: { select: { email: true } } },
    });
    if (!old) throw new NotFoundException("Invitation not found");
    if (old.status !== StaffInvitationStatus.PENDING)
      throw new BadRequestException("Only a pending invitation can be resent");
    const activationToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
    const invitation = await this.prisma.staffInvitation.update({
      where: { id },
      data: {
        activationTokenHash: this.activationTokenHash(activationToken),
        expiresAt,
      },
    });
    await this.sendActivationEmail({
      invitationId: invitation.id,
      email: invitation.email,
      accountType: invitation.accountType,
      expiresAt,
      activationToken,
      inviterEmail: old.invitedBy.email,
    });
    const actor = await this.prisma.user.findUnique({
      where: { clerkId: actorClerkId },
    });
    await this.audit(actor?.id, "StaffInvitation", id, "RESENT", null);
    return { ...invitation, delivery: "SENT" as const };
  }
  async activateInvitation(tokenInput: string, password: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    if (typeof tokenInput !== "string" || tokenInput.length < 32)
      throw new BadRequestException("This activation link is invalid or expired");
    if (typeof password !== "string" || password.length < 12)
      throw new BadRequestException("Choose a password of at least 12 characters");
    if (!process.env.CLERK_SECRET_KEY)
      throw new BadRequestException("Staff identity service is not configured");
    const invitation = await this.prisma.staffInvitation.findFirst({
      where: {
        activationTokenHash: this.activationTokenHash(tokenInput),
        status: StaffInvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
    });
    if (!invitation)
      throw new BadRequestException("This activation link is invalid or expired");
    if (await this.prisma.user.findUnique({ where: { email: invitation.email } }))
      throw new BadRequestException("This email already belongs to an account");
    let clerkUserId: string;
    try {
      const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
      const clerkUser = await clerk.users.createUser({
        emailAddress: [invitation.email],
        password,
        publicMetadata: { accountType: invitation.accountType },
      });
      clerkUserId = clerkUser.id;
    } catch (error) {
      const failure = mapClerkActivationFailure(error);
      this.logger.warn({
        event: "staff_activation_clerk_failed",
        invitationId: invitation.id,
        status: failure.status ?? "unknown",
        providerCodes:
          failure.providerCodes.length > 0
            ? failure.providerCodes
            : ["unknown"],
      });
      throw new ApiException({
        code: failure.code,
        message: failure.message,
        status: HttpStatus.BAD_REQUEST,
      });
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            clerkId: clerkUserId,
            email: invitation.email,
            accountType: invitation.accountType,
          },
        });
        const role = await tx.role.upsert({
          where: { name: invitation.accountType },
          update: {},
          create: { name: invitation.accountType },
        });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
        await tx.staffInvitation.update({
          where: { id: invitation.id },
          data: {
            status: StaffInvitationStatus.ACCEPTED,
            acceptedById: user.id,
            acceptedAt: new Date(),
            activationTokenHash: null,
            clerkInvitationId: clerkUserId,
          },
        });
        await tx.auditLog.create({
          data: {
            module: "IDENTITY",
            entity: "StaffInvitation",
            entityId: invitation.id,
            action: "ACCEPTED",
            performedById: user.id,
            newValue: { accountType: invitation.accountType, email: invitation.email },
          },
        });
      });
    } catch (error) {
      await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })
        .users.deleteUser(clerkUserId)
        .catch(() => undefined);
      throw error;
    }
    return { email: invitation.email, accountType: invitation.accountType };
  }
  private activationTokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  private async sendActivationEmail(input: {
    invitationId: string;
    email: string;
    accountType: UserRoleName;
    expiresAt: Date;
    activationToken: string;
    inviterEmail: string;
  }) {
    if (!this.email)
      throw new BadRequestException("Staff email delivery is not configured");
    const base = (process.env.OPS_WEB_URL ?? "http://localhost:3001").replace(
      /\/+$/,
      "",
    );
    const url = new URL("/staff-activate", `${base}/`);
    url.searchParams.set("token", input.activationToken);
    const role =
      input.accountType === UserRoleName.SUPER_ADMIN
        ? "Super Admin"
        : "Operations";
    const expiry = input.expiresAt.toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kathmandu",
    });
    await this.email.send({
      to: input.email,
      subject: "Activate your Visa Compass staff account",
      text: `You have been invited by ${input.inviterEmail} as ${role}. Activate your account and choose a password: ${url.toString()}\n\nThis single-use link expires ${expiry} Nepal time. If you were not expecting this invitation, ignore this email.`,
      html: `<main style="font-family:Arial,sans-serif;color:#18212f;max-width:560px;margin:auto"><h1 style="font-size:24px">Visa Compass staff account</h1><p>You have been invited by <strong>${this.escapeHtml(input.inviterEmail)}</strong> as <strong>${role}</strong>.</p><p><a href="${url.toString()}" style="display:inline-block;padding:12px 18px;background:#0f766e;color:#fff;text-decoration:none;border-radius:6px">Activate staff account</a></p><p style="color:#52606d">This single-use link expires ${this.escapeHtml(expiry)} Nepal time. You will choose your own password; Visa Compass will never email one to you.</p></main>`,
      idempotencyKey: `staff-activation-${input.invitationId}-${this.activationTokenHash(input.activationToken)}`,
    });
  }
  private escapeHtml(value: string) {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return value.replace(/[&<>'"]/g, (character) => entities[character]!);
  }
  async changeAccountType(
    userId: string,
    accountType: UserRoleName,
    actorClerkId: string,
  ) {
    if (
      accountType !== UserRoleName.OPERATIONS &&
      accountType !== UserRoleName.SUPER_ADMIN
    )
      throw new BadRequestException("Staff account type is required");
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { customer: { include: { orders: true, esims: true } } },
    });
    if (!user) throw new NotFoundException("User not found");
    if (user.accountType === UserRoleName.CUSTOMER || user.customer)
      throw new BadRequestException(
        "Customer identities cannot be converted to staff",
      );
    await this.ensureFinalAdmin(user, accountType, undefined);
    const actor = await this.prisma.user.findUnique({
      where: { clerkId: actorClerkId },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { accountType } });
      await tx.userRole.deleteMany({ where: { userId } });
      const role = await tx.role.upsert({
        where: { name: accountType },
        update: {},
        create: { name: accountType },
      });
      await tx.userRole.create({ data: { userId, roleId: role.id } });
      await tx.auditLog.create({
        data: {
          module: "IDENTITY",
          entity: "User",
          entityId: userId,
          action: "ACCOUNT_TYPE_CHANGED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { accountType: user.accountType },
          newValue: { accountType },
        },
      });
    });
    return (await this.users({ limit: 200 })).items.find(
      (item) => item.id === userId,
    );
  }
  async changeStatus(userId: string, status: UserStatus, actorClerkId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    await this.ensureFinalAdmin(user, undefined, status);
    const actor = await this.prisma.user.findUnique({
      where: { clerkId: actorClerkId },
    });
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
    });
    await this.audit(actor?.id, "User", userId, "STATUS_CHANGED", {
      from: user.status,
      to: status,
    });
    return updated;
  }
  private async ensureFinalAdmin(
    user: { id: string; accountType: UserRoleName; status: UserStatus },
    nextType?: UserRoleName,
    nextStatus?: UserStatus,
  ) {
    if (
      user.accountType !== UserRoleName.SUPER_ADMIN ||
      user.status !== UserStatus.ACTIVE
    )
      return;
    if (
      (nextType ?? user.accountType) === UserRoleName.SUPER_ADMIN &&
      (nextStatus ?? user.status) === UserStatus.ACTIVE
    )
      return;
    const count = await this.prisma.user.count({
      where: {
        accountType: UserRoleName.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    if (count <= 1)
      throw new BadRequestException(
        "The final active Super Admin cannot be removed or disabled",
      );
  }
  private async audit(
    performedById: string | undefined,
    entity: string,
    entityId: string,
    action: string,
    newValue: object | null,
  ) {
    await this.prisma.auditLog.create({
      data: {
        module: "IDENTITY",
        entity,
        entityId,
        action,
        ...(performedById ? { performedById } : {}),
        ...(newValue ? { newValue } : {}),
      },
    });
  }
}
