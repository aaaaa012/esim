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
import { FonepayGateway } from "../payments/gateways/fonepay.gateway.js";
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

  if (providerCodes.includes("form_data_missing")) {
    return {
      code: "STAFF_PROFILE_INCOMPLETE",
      message:
        "The required account details could not be accepted. Contact support if the problem continues.",
      providerCodes,
      status,
    };
  }
  if (
    /identifier.*(exists|taken)|email.*(exists|taken)|already.*(exists|registered)/.test(
      joinedCodes,
    )
  ) {
    return {
      code: "STAFF_IDENTITY_EXISTS",
      message:
        "An account already exists for this email. Return to sign in or contact support.",
      providerCodes,
      status,
    };
  }
  if (/password|pwned|breach/.test(joinedCodes)) {
    return {
      code: "STAFF_PASSWORD_REJECTED",
      message:
        "This password could not be accepted. Choose a different strong password.",
      providerCodes,
      status,
    };
  }
  if (
    status === HttpStatus.TOO_MANY_REQUESTS ||
    /rate.*limit/.test(joinedCodes)
  ) {
    return {
      code: "STAFF_ACTIVATION_RATE_LIMITED",
      message:
        "Too many activation attempts. Wait a few minutes and try again.",
      providerCodes,
      status,
    };
  }
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
    return {
      code: "STAFF_IDENTITY_UNAVAILABLE",
      message:
        "Account activation is temporarily unavailable. Contact support if the problem continues.",
      providerCodes,
      status,
    };
  }
  return {
    code: "STAFF_ACTIVATION_FAILED",
    message:
      "Unable to activate this staff account. Contact support if the problem continues.",
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
    private readonly fonepay: FonepayGateway = new FonepayGateway(),
    @Optional() @Inject(EMAIL_CHANNEL) private readonly email?: EmailChannel,
  ) {}

  async documentReviewPolicy() {
    if (!this.prisma.enabled)
      return { policy: DocumentReviewPolicy.AUTO_OCR, ocrCheckoutWaitMs: 8000 };
    const config = await this.prisma.platformConfiguration.findUnique({
      where: { id: "platform" },
      select: {
        documentReviewPolicy: true,
        ocrCheckoutWaitMs: true,
        updatedAt: true,
      },
    });
    return {
      policy: config?.documentReviewPolicy ?? DocumentReviewPolicy.AUTO_OCR,
      ocrCheckoutWaitMs: config?.ocrCheckoutWaitMs ?? 8000,
      ...(config?.updatedAt ? { updatedAt: config.updatedAt } : {}),
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
    const updated = await this.prisma.$transaction(async (tx) => {
      const previous = await tx.platformConfiguration.findUnique({
        where: { id: "platform" },
      });
      const next = await tx.platformConfiguration.upsert({
        where: { id: "platform" },
        update: {
          documentReviewPolicy: input.policy,
          ocrCheckoutWaitMs: waitMs,
          updatedById: actor?.id ?? null,
        },
        create: {
          id: "platform",
          documentReviewPolicy: input.policy,
          ocrCheckoutWaitMs: waitMs,
          updatedById: actor?.id ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          module: "DOCUMENT_RULES",
          entity: "PlatformConfiguration",
          entityId: next.id,
          action: "DOCUMENT_REVIEW_POLICY_CHANGED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: {
            policy:
              previous?.documentReviewPolicy ?? DocumentReviewPolicy.AUTO_OCR,
            ocrCheckoutWaitMs: previous?.ocrCheckoutWaitMs ?? 8000,
          },
          newValue: {
            policy: next.documentReviewPolicy,
            ocrCheckoutWaitMs: next.ocrCheckoutWaitMs,
          },
        },
      });
      return next;
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
    mode: "UPDATE_LISTED" | "FULL_CATALOG" = "UPDATE_LISTED",
  ) {
    if (!["UPDATE_LISTED", "FULL_CATALOG"].includes(mode))
      throw new BadRequestException("Unsupported plan import mode");
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const actor = actorClerkId ? await this.actor(actorClerkId) : null;
    // New products are conservative by default. Existing active products can
    // receive monthly price/provider updates immediately; a new product only
    // becomes active when a Super Admin explicitly supplies ACTIVE.
    const roleDefaultStatus = PlanStatus.DRAFT;
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
    const importedAt = new Date();
    const fileKeys = new Set<string>();
    const seenKeys = new Set<string>();
    const historyRows: Array<{
      planId?: string;
      countryIso2: string;
      providerPlanId: string;
      change:
        "NEW" | "UPDATED" | "UNCHANGED" | "MISSING" | "RETURNED" | "INVALID";
      previousValue?: Prisma.InputJsonValue;
      proposedValue?: Prisma.InputJsonValue;
      error?: string;
    }> = [];
    const existingPlans = await this.prisma.plan.findMany({
      include: { country: true },
    });
    const existingByKey = new Map(
      existingPlans.map((plan) => [
        `${plan.country.isoCode.toUpperCase()}::${plan.providerPlanId}`,
        plan,
      ]),
    );
    const counts = {
      NEW: 0,
      UPDATED: 0,
      UNCHANGED: 0,
      MISSING: 0,
      RETURNED: 0,
      INVALID: 0,
    };
    let imported = 0;
    let updated = 0;
    for (const [index, row] of records.entries()) {
      const line = index + 2;
      const countryIso2 = (row.countryiso2 ?? "").trim().toUpperCase();
      const name = (row.name ?? "").trim();
      const providerPlanId = (row.providerplanid ?? "").trim();
      const key = `${countryIso2}::${providerPlanId}`;
      if (countryIso2 && providerPlanId) fileKeys.add(key);
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
      const invalid = (message: string) => {
        rowErrors.push(`Line ${line}: ${message}`);
        counts.INVALID += 1;
        historyRows.push({
          countryIso2: countryIso2 || "(empty)",
          providerPlanId: providerPlanId || "(empty)",
          change: "INVALID",
          error: message,
          proposedValue: row,
        });
      };
      if (seenKeys.has(key)) {
        invalid(
          `duplicate package ${countryIso2}/${providerPlanId} within the file`,
        );
        continue;
      }
      seenKeys.add(key);
      if (!/^[A-Z]{2}$/.test(countryIso2)) {
        invalid(`invalid countryIso2 '${countryIso2 || "(empty)"}'`);
        continue;
      }
      if (statusRaw && !requestedStatus) {
        invalid("status must be ACTIVE, DRAFT, DISABLED, or ARCHIVED");
        continue;
      }
      if (popularRaw && !["true", "false", "1", "0"].includes(popularRaw)) {
        invalid("popular must be true, false, 1, or 0");
        continue;
      }
      if (isRestrictedPlanCountry(countryIso2)) {
        invalid(`destination country '${countryIso2}' is not supported`);
        continue;
      }
      if (!name) {
        invalid("name is required");
        continue;
      }
      if (!providerPlanId) {
        invalid("providerPlanId is required");
        continue;
      }
      if (!dataAllowance) {
        invalid("dataAllowance is required");
        continue;
      }
      if (
        validityDays === null ||
        !Number.isInteger(validityDays) ||
        validityDays < 1 ||
        validityDays > 3650
      ) {
        invalid("validityDays must be a whole number between 1 and 3650");
        continue;
      }
      if (
        !Number.isFinite(costPrice) ||
        costPrice < 0 ||
        costPrice > 9999999999.99
      ) {
        invalid("costPrice must be a non-negative number");
        continue;
      }
      if (
        !Number.isFinite(sellingPrice) ||
        sellingPrice < 0 ||
        sellingPrice > 9999999999.99
      ) {
        invalid("sellingPrice must be a non-negative number");
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
        const existing =
          existingByKey.get(key) ??
          (await this.prisma.plan.findUnique({
            where: {
              countryId_providerPlanId: {
                countryId: country.id,
                providerPlanId,
              },
            },
          }));
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
          const returning = Boolean(existing.providerMissingSince);
          const nextStatus = returning ? PlanStatus.DRAFT : effectiveStatus;
          const proposed = {
            ...data,
            status: nextStatus,
            popular: popular ?? existing.popular,
          };
          const previous = {
            name: existing.name,
            dataAllowance: existing.dataAllowance,
            validityDays: existing.validityDays,
            costPrice: Number(existing.costPrice),
            sellingPrice: Number(existing.sellingPrice),
            currency: existing.currency,
            coverage: existing.coverage,
            popular: existing.popular,
            status: existing.status,
          };
          const changed = Object.keys(proposed).some(
            (field) =>
              JSON.stringify(previous[field as keyof typeof previous]) !==
              JSON.stringify(proposed[field as keyof typeof proposed]),
          );
          const persisted = await this.prisma.plan.update({
            where: { id: existing.id },
            data: {
              ...data,
              status: nextStatus,
              ...(popular !== undefined ? { popular } : {}),
              lastCatalogSeenAt: importedAt,
              providerMissingSince: null,
            },
          });
          const change = returning
            ? "RETURNED"
            : changed
              ? "UPDATED"
              : "UNCHANGED";
          counts[change] += 1;
          historyRows.push({
            planId: persisted.id,
            countryIso2,
            providerPlanId,
            change,
            previousValue: previous,
            proposedValue: proposed,
          });
          if (change === "UPDATED") updated++;
        } else {
          const persisted = await this.prisma.plan.create({
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
              lastCatalogSeenAt: importedAt,
            },
          });
          counts.NEW += 1;
          historyRows.push({
            planId: persisted.id,
            countryIso2,
            providerPlanId,
            change: "NEW",
            proposedValue: {
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
        invalid(error instanceof Error ? error.message : "failed to persist");
      }
    }
    for (const plan of mode === "FULL_CATALOG" ? existingPlans : []) {
      const key = `${plan.country.isoCode.toUpperCase()}::${plan.providerPlanId}`;
      if (fileKeys.has(key)) continue;
      const missingSince = plan.providerMissingSince ?? importedAt;
      await this.prisma.plan.update({
        where: { id: plan.id },
        data: { providerMissingSince: missingSince },
      });
      counts.MISSING += 1;
      historyRows.push({
        planId: plan.id,
        countryIso2: plan.country.isoCode,
        providerPlanId: plan.providerPlanId,
        change: "MISSING",
        previousValue: {
          name: plan.name,
          sellingPrice: Number(plan.sellingPrice),
          status: plan.status,
          missingSince: plan.providerMissingSince?.toISOString() ?? null,
        },
      });
    }
    let catalogBatchId: string | null = null;
    const catalogDelegate = this.prisma.catalogImportBatch;
    if (catalogDelegate) {
      const created = await catalogDelegate.create({
        data: {
          batchReference: `CAT-${importedAt.toISOString().replace(/[:.]/g, "-")}`,
          fileName: fileName ?? null,
          contentHash: createHash("sha256").update(content).digest("hex"),
          mode,
          uploadedById: actor?.id ?? null,
          totalRows: historyRows.length,
          newCount: counts.NEW,
          updatedCount: counts.UPDATED,
          unchangedCount: counts.UNCHANGED,
          missingCount: counts.MISSING,
          returnedCount: counts.RETURNED,
          invalidCount: counts.INVALID,
          rows: { create: historyRows },
        },
      });
      catalogBatchId = created.id;
    }
    const summary = {
      mode,
      imported,
      updated,
      unchanged: counts.UNCHANGED,
      missing: counts.MISSING,
      returned: counts.RETURNED,
      skipped: rowErrors.length,
      errors: rowErrors.slice(0, 100),
      batchId: catalogBatchId,
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
        capabilities: {
          checkout: true,
          authoritativeStatusLookup: true,
          automatedDisputeFeed: true,
          refundMode: "MANUAL_IN_PROVIDER_PORTAL",
        },
      },
      {
        id: "fonepay",
        name: "Fonepay Payment Gateway",
        category: "PAYMENT",
        provider: "FONEPAY",
        enabled:
          process.env.FONEPAY_ENABLED === "true" &&
          configured([
            "FONEPAY_BASE_URL",
            "FONEPAY_USERNAME",
            "FONEPAY_PASSWORD",
            "FONEPAY_TERMINAL_ID",
          ]) &&
          Boolean(
            process.env.FONEPAY_PRIVATE_KEY_PATH ||
            process.env.FONEPAY_PRIVATE_KEY_BASE64,
          ),
        status:
          process.env.FONEPAY_ENABLED === "true" &&
          configured([
            "FONEPAY_BASE_URL",
            "FONEPAY_USERNAME",
            "FONEPAY_PASSWORD",
            "FONEPAY_TERMINAL_ID",
          ]) &&
          Boolean(
            process.env.FONEPAY_PRIVATE_KEY_PATH ||
            process.env.FONEPAY_PRIVATE_KEY_BASE64,
          )
            ? "HEALTHY"
            : "CONFIG_REQUIRED",
        capabilities: {
          checkout: true,
          authoritativeStatusLookup: true,
          bankDirectory: true,
          websocketSignal: true,
          automatedDisputeFeed: false,
          refundMode: "MANUAL_IN_PROVIDER_PORTAL",
        },
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
    if (id === "fonepay") {
      const directory = await this.fonepay.syncBankDirectory();
      return {
        id,
        status: "HEALTHY",
        checkedAt: new Date().toISOString(),
        message: `Fonepay authenticated and returned ${directory.banks.length} active banking destinations.`,
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

  fonepayBanks() {
    return this.fonepay.bankDirectory();
  }

  syncFonepayBanks() {
    return this.fonepay.syncBankDirectory();
  }

  /**
   * Declared capabilities of every registered payment gateway, surfaced to
   * Operations verbatim. Financial support that the provider does NOT have
   * (for example Fonepay's QR-only checkout or manual-only refunds) is shown
   * explicitly so Ops never mistakes brand presence for feature parity.
   */
  paymentProviderCapabilities() {
    const fonepayConfigured = Boolean(
      process.env.FONEPAY_ENABLED === "true" &&
      process.env.FONEPAY_BASE_URL &&
      process.env.FONEPAY_USERNAME &&
      process.env.FONEPAY_PASSWORD &&
      process.env.FONEPAY_TERMINAL_ID &&
      (process.env.FONEPAY_PRIVATE_KEY_PATH ||
        process.env.FONEPAY_PRIVATE_KEY_BASE64),
    );
    return [
      {
        provider: this.khalti.provider,
        configured: true,
        capabilities: this.khalti.capabilities(),
        notes: [
          "Wallet redirect checkout; confirmation is processed by the backend only.",
        ],
      },
      {
        provider: this.fonepay.provider,
        configured: fonepayConfigured,
        capabilities: this.fonepay.capabilities(),
        notes: [
          "QR checkout with banking-app deep links.",
          "Bank list shown at checkout is indicative, not exhaustive.",
          "Refunds are completed manually in the FinBridge portal and recorded here afterwards.",
          "Dispute ingestion is not supported; raise disputes directly with Fonepay.",
        ],
      },
    ];
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
  async exportOperatingCatalog() {
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

  /** Fetches a fresh provider snapshot without changing the operating catalogue. */
  async exportTransatelCatalog(cos?: string) {
    this.requireTransatel();
    const report = await this.connectivity.catalogReport(cos);
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
    const csv = [
      columns.join(","),
      ...report.rows.map((row) =>
        columns
          .map((column) =>
            this.csvCell(
              column === "popular"
                ? false
                : (row as unknown as Record<string, unknown>)[column],
            ),
          )
          .join(","),
      ),
    ].join("\n");
    return {
      fileName: `transatel-catalog-${new Date().toISOString().slice(0, 10)}.csv`,
      count: report.rows.length,
      skipped: report.skipped.length,
      skippedIds: report.skipped,
      csv,
    };
  }

  async catalogImportBatches(limit = 24) {
    if (!this.prisma.enabled) return [];
    return this.prisma.catalogImportBatch.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(100, Math.max(1, limit)),
    });
  }

  async catalogImportBatch(id: string, change?: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const allowed = [
      "NEW",
      "UPDATED",
      "UNCHANGED",
      "MISSING",
      "RETURNED",
      "INVALID",
    ];
    if (change && !allowed.includes(change))
      throw new BadRequestException("Unknown catalogue change filter");
    const batch = await this.prisma.catalogImportBatch.findUnique({
      where: { id },
      include: {
        rows: {
          ...(change
            ? {
                where: {
                  change: change as
                    | "NEW"
                    | "UPDATED"
                    | "UNCHANGED"
                    | "MISSING"
                    | "RETURNED"
                    | "INVALID",
                },
              }
            : {}),
          orderBy: [{ countryIso2: "asc" }, { providerPlanId: "asc" }],
        },
      },
    });
    if (!batch) throw new NotFoundException("Catalogue import batch not found");
    return batch;
  }

  async disableMissingCatalogPlan(
    batchId: string,
    rowId: string,
    actorClerkId: string,
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const row = await this.prisma.catalogImportRow.findFirst({
      where: { id: rowId, batchId, change: "MISSING" },
    });
    if (!row?.planId)
      throw new BadRequestException("This row is not a missing package");
    const plan = await this.prisma.plan.findUnique({
      where: { id: row.planId },
    });
    if (!plan) throw new NotFoundException("Package not found");
    const actor = await this.actor(actorClerkId);
    await this.prisma.$transaction([
      this.prisma.plan.update({
        where: { id: plan.id },
        data: { status: PlanStatus.DISABLED },
      }),
      this.prisma.auditLog.create({
        data: {
          module: "PLAN_ADMIN",
          entity: "Plan",
          entityId: plan.id,
          action: "MISSING_PLAN_DISABLED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { status: plan.status },
          newValue: {
            status: PlanStatus.DISABLED,
            catalogImportBatchId: batchId,
          },
        },
      }),
    ]);
    return { id: plan.id, status: PlanStatus.DISABLED };
  }

  private csvCell(value: unknown): string {
    const raw = String(value ?? "");
    if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
    return raw;
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

  async correctCustomerEmail(
    customerId: string,
    emailInput: string,
    reasonInput: string,
    actorClerkId: string,
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const email = emailInput.trim().toLowerCase();
    const reason = reasonInput.trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)
      throw new BadRequestException("Enter a valid email address");
    if (reason.length < 10 || reason.length > 500)
      throw new BadRequestException(
        "Provide a reason between 10 and 500 characters",
      );
    if (!process.env.CLERK_SECRET_KEY)
      throw new BadRequestException("Customer identity service is unavailable");
    const [customer, actor] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        include: { user: true, partnerIdentity: true },
      }),
      this.prisma.user.findUnique({ where: { clerkId: actorClerkId } }),
    ]);
    if (!customer) throw new NotFoundException("Customer not found");
    if (!actor || actor.accountType !== UserRoleName.SUPER_ADMIN)
      throw new BadRequestException("Super Admin approval is required");
    if (!customer.user || customer.user.accountType !== UserRoleName.CUSTOMER)
      throw new BadRequestException(
        "Only a customer login account can have its sign-in email corrected",
      );
    if (customer.partnerIdentity)
      throw new BadRequestException(
        "Partner-managed identities must be corrected by the owning partner",
      );
    if (customer.email === email && customer.user.email === email)
      return { changed: false, email };
    const conflict = await this.prisma.user.findUnique({ where: { email } });
    if (conflict && conflict.id !== customer.user.id)
      throw new BadRequestException("That email already belongs to an account");
    const customerConflict = await this.prisma.customer.findUnique({
      where: { email },
    });
    if (customerConflict && customerConflict.id !== customer.id)
      throw new BadRequestException("That email already belongs to a customer");

    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    let newAddressId: string | undefined;
    let previousPrimaryAddressId: string | null | undefined;
    let sessionIds: string[] = [];
    try {
      const clerkUser = await clerk.users.getUser(customer.user.clerkId);
      previousPrimaryAddressId = clerkUser.primaryEmailAddressId;
      const existingAddress = clerkUser.emailAddresses.find(
        (item) => item.emailAddress.trim().toLowerCase() === email,
      );
      const address =
        existingAddress ??
        (await clerk.emailAddresses.createEmailAddress({
          userId: customer.user.clerkId,
          emailAddress: email,
          verified: true,
        }));
      newAddressId = existingAddress ? undefined : address.id;
      await clerk.users.updateUser(customer.user.clerkId, {
        primaryEmailAddressID: address.id,
        notifyPrimaryEmailAddressChanged: true,
      });
      const sessions = await clerk.sessions.getSessionList({
        userId: customer.user.clerkId,
        limit: 100,
      });
      sessionIds = sessions.data.map((session) => session.id);
    } catch (error) {
      if (newAddressId)
        await clerk.emailAddresses
          .deleteEmailAddress(newAddressId)
          .catch(() => undefined);
      this.logger.warn({
        event: "customer_email_correction_identity_failed",
        customerId,
        actorId: actor.id,
      });
      throw new BadRequestException(
        "The sign-in email could not be updated. No local change was saved.",
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: customer.user!.id },
          data: { email },
        });
        await tx.customer.update({
          where: { id: customer.id },
          data: { email },
        });
        await tx.auditLog.create({
          data: {
            module: "CUSTOMER_IDENTITY",
            entity: "Customer",
            entityId: customer.id,
            action: "EMAIL_CORRECTED",
            performedById: actor.id,
            previousValue: { email: customer.email },
            newValue: { email, reason },
          },
        });
      });
    } catch {
      let rolledBack = false;
      if (previousPrimaryAddressId) {
        try {
          await clerk.users.updateUser(customer.user.clerkId, {
            primaryEmailAddressID: previousPrimaryAddressId,
            notifyPrimaryEmailAddressChanged: false,
          });
          if (newAddressId)
            await clerk.emailAddresses.deleteEmailAddress(newAddressId);
          rolledBack = true;
        } catch {
          // The structured log below is an explicit reconciliation signal.
        }
      }
      this.logger.error({
        event: "customer_email_correction_reconciliation_required",
        customerId,
        actorId: actor.id,
        identityRollbackSucceeded: rolledBack,
      });
      throw new BadRequestException(
        rolledBack
          ? "The email change could not be saved and was rolled back. Please try again."
          : "The identity update needs administrator reconciliation. Do not retry this change.",
      );
    }
    const revocations = await Promise.allSettled(
      sessionIds.map((id) => clerk.sessions.revokeSession(id)),
    );
    const revoked = revocations.filter(
      (result) => result.status === "fulfilled",
    ).length;
    if (revoked !== sessionIds.length)
      this.logger.warn({
        event: "customer_email_correction_session_revocation_incomplete",
        customerId,
        actorId: actor.id,
        expected: sessionIds.length,
        revoked,
      });
    return {
      changed: true,
      email,
      sessionsRevoked: revoked,
      sessionsFound: sessionIds.length,
    };
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
    let clerkCleanup: "NOT_REQUIRED" | "SUCCEEDED" | "FAILED" = "NOT_REQUIRED";
    let clerkCleanupError: string | null = null;
    if (invitation.clerkInvitationId && process.env.CLERK_SECRET_KEY) {
      try {
        await createClerkClient({
          secretKey: process.env.CLERK_SECRET_KEY,
        }).users.deleteUser(invitation.clerkInvitationId);
        clerkCleanup = "SUCCEEDED";
      } catch (error) {
        clerkCleanup = "FAILED";
        clerkCleanupError =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown error";
        this.logger.warn({
          event: "staff_invitation_clerk_cleanup_failed",
          invitationId: invitation.id,
          clerkReference: invitation.clerkInvitationId,
          error: clerkCleanupError,
        });
      }
    }
    const updated = await this.prisma.staffInvitation.update({
      where: { id },
      data: { status: StaffInvitationStatus.REVOKED, revokedAt: new Date() },
    });
    await this.audit(actor?.id, "StaffInvitation", id, "REVOKED", {
      clerkCleanup,
      ...(clerkCleanupError ? { clerkCleanupError } : {}),
    });
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
  async activateInvitation(
    tokenInput: string,
    firstNameInput: string,
    lastNameInput: string,
    password: string,
  ) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    if (typeof tokenInput !== "string" || tokenInput.length < 32)
      throw new BadRequestException(
        "This activation link is invalid or expired",
      );
    if (typeof password !== "string" || password.length < 12)
      throw new BadRequestException(
        "Choose a password of at least 12 characters",
      );
    const firstName = firstNameInput.trim();
    const lastName = lastNameInput.trim();
    if (!firstName || firstName.length > 100)
      throw new BadRequestException("Enter a valid first name");
    if (!lastName || lastName.length > 100)
      throw new BadRequestException("Enter a valid last name");
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
      throw new BadRequestException(
        "This activation link is invalid or expired",
      );
    if (
      await this.prisma.user.findUnique({ where: { email: invitation.email } })
    )
      throw new BadRequestException("This email already belongs to an account");
    let clerkUserId: string;
    try {
      const clerk = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      const clerkUser = await clerk.users.createUser({
        emailAddress: [invitation.email],
        firstName,
        lastName,
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
        await tx.userRole.create({
          data: { userId: user.id, roleId: role.id },
        });
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
            newValue: {
              accountType: invitation.accountType,
              email: invitation.email,
            },
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
