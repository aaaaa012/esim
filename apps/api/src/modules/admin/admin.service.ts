import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DocumentReviewPolicy,
  PlanStatus,
  StaffInvitationStatus,
  UserRoleName,
  UserStatus,
  Prisma,
} from "@prisma/client";
import { randomBytes } from "node:crypto";
import { isRestrictedPlanCountry, RESTRICTED_PLAN_COUNTRY_CODES } from "@visa-compass/shared";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { createClerkClient } from "@clerk/backend";
import { tabularToRecords } from "../../common/tabular.util.js";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService, private readonly connectivity: ConnectivityService) {}

  async documentReviewPolicy() {
    if (!this.prisma.enabled) return { policy: DocumentReviewPolicy.AUTO_OCR, ocrCheckoutWaitMs: 8000 };
    const config = await this.prisma.platformConfiguration.upsert({ where: { id: "platform" }, update: {}, create: { id: "platform" } });
    return { policy: config.documentReviewPolicy, ocrCheckoutWaitMs: config.ocrCheckoutWaitMs, updatedAt: config.updatedAt };
  }

  async updateDocumentReviewPolicy(input: { policy: DocumentReviewPolicy; ocrCheckoutWaitMs?: number }, actorClerkId: string) {
    if (!Object.values(DocumentReviewPolicy).includes(input.policy)) throw new BadRequestException("Invalid document review policy");
    const waitMs = input.ocrCheckoutWaitMs ?? 8000;
    if (!Number.isInteger(waitMs) || waitMs < 1000 || waitMs > 30000) throw new BadRequestException("OCR checkout wait must be between 1 and 30 seconds");
    const actor = await this.actor(actorClerkId);
    const previous = await this.prisma.platformConfiguration.upsert({ where: { id: "platform" }, update: {}, create: { id: "platform" } });
    const updated = await this.prisma.platformConfiguration.update({ where: { id: "platform" }, data: { documentReviewPolicy: input.policy, ocrCheckoutWaitMs: waitMs, updatedById: actor?.id ?? null } });
    await this.prisma.auditLog.create({ data: { module: "DOCUMENT_RULES", entity: "PlatformConfiguration", entityId: updated.id, action: "DOCUMENT_REVIEW_POLICY_CHANGED", ...(actor ? { performedById: actor.id } : {}), previousValue: { policy: previous.documentReviewPolicy, ocrCheckoutWaitMs: previous.ocrCheckoutWaitMs }, newValue: { policy: updated.documentReviewPolicy, ocrCheckoutWaitMs: updated.ocrCheckoutWaitMs } } });
    return { policy: updated.documentReviewPolicy, ocrCheckoutWaitMs: updated.ocrCheckoutWaitMs, updatedAt: updated.updatedAt };
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

  async planPage(input: { q?: string; status?: PlanStatus; limit?: number; offset?: number }) {
    if (!this.prisma.enabled) return { items: [], total: 0, limit: 50, offset: 0 };
    const limit = Math.min(100, Math.max(1, Number.isFinite(input.limit) ? input.limit! : 50));
    const offset = Math.max(0, Number.isFinite(input.offset) ? input.offset! : 0);
    const query = input.q?.trim();
    const where: Prisma.PlanWhereInput = {
      country: { isoCode: { notIn: [...RESTRICTED_PLAN_COUNTRY_CODES] } },
      ...(input.status ? { status: input.status } : {}),
      ...(query ? { OR: [
        { name: { contains: query, mode: "insensitive" } },
        { providerPlanId: { contains: query, mode: "insensitive" } },
        { country: { name: { contains: query, mode: "insensitive" } } },
        { country: { isoCode: { equals: query.toUpperCase() } } },
      ] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.plan.findMany({
        where,
        select: { id: true, name: true, dataAllowance: true, validityDays: true, sellingPrice: true, costPrice: true, currency: true, popular: true, status: true, country: { select: { isoCode: true, name: true } } },
        orderBy: [{ country: { name: "asc" } }, { sellingPrice: "asc" }, { id: "asc" }],
        take: limit,
        skip: offset,
      }),
      this.prisma.plan.count({ where }),
    ]);
    return {
      items: rows.map((plan) => ({ id: plan.id, name: plan.name, countryCode: plan.country.isoCode, countryName: plan.country.name, dataAllowance: plan.dataAllowance, validityDays: plan.validityDays, sellingPriceNpr: Number(plan.sellingPrice), costPriceNpr: Number(plan.costPrice), currency: plan.currency, popular: plan.popular, status: plan.status })),
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
    if (!this.prisma.enabled) throw new BadRequestException("Database persistence is required");
    const plan = await this.prisma.plan.findUnique({ where: { id }, include: { country: true } });
    if (!plan) throw new NotFoundException("Plan not found");
    if (plan.status !== PlanStatus.DRAFT) throw new BadRequestException(`Plan is ${plan.status.toLowerCase()}; only draft plans can be approved`);
    if (isRestrictedPlanCountry(plan.country.isoCode)) throw new BadRequestException(`Plans for destination country ${plan.country.isoCode} are not supported`);
    const actor = await this.actor(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.plan.update({ where: { id }, data: { status: PlanStatus.ACTIVE } });
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
    if (!this.prisma.enabled) throw new BadRequestException("Database persistence is required");
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException("Plan not found");
    if (plan.status === PlanStatus.ACTIVE) throw new BadRequestException("An active plan cannot be rejected; disable it instead");
    const actor = await this.actor(actorClerkId);
    await this.prisma.$transaction(async (tx) => {
      await tx.plan.update({ where: { id }, data: { status: PlanStatus.ARCHIVED } });
      await tx.auditLog.create({
        data: {
          module: "PLAN_ADMIN",
          entity: "Plan",
          entityId: id,
          action: "PLAN_REJECTED",
          ...(actor ? { performedById: actor.id } : {}),
          previousValue: { status: plan.status },
          newValue: { status: PlanStatus.ARCHIVED, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
        },
      });
    });
    return (await this.plans()).find((item) => item.id === id);
  }

  private async actor(actorClerkId: string) {
    try {
      return await this.prisma.user.findUnique({ where: { clerkId: actorClerkId } });
    } catch {
      return null;
    }
  }

  async importPlansFromTabular(content: string, fileName?: string, actorClerkId?: string) {
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
      ["countryiso2", "name", "providerplanid", "dataallowance", "validitydays", "costprice", "sellingprice"],
      fileName ? { fileName, maxRows: 2000 } : { maxRows: 2000 },
    );
    if (errors.length) throw new BadRequestException(errors.join("; "));
    if (records.length > 2000)
      throw new BadRequestException("A single upload is limited to 2,000 rows");
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
      const costPrice = Number.isFinite(parsedCost) && parsedCost >= 0 ? parsedCost : sellingPrice;
      const currency = (row.currency ?? "NPR").trim().toUpperCase();
      const popular =
        (row.popular ?? "").toLowerCase() === "true" ||
        (row.popular ?? "").trim() === "1";
      const statusRaw = (row.status ?? "").trim().toUpperCase();
      const status: PlanStatus =
        statusRaw === "DRAFT" ||
        statusRaw === "DISABLED" ||
        statusRaw === "ARCHIVED"
          ? statusRaw
          : roleDefaultStatus;
      const coverageCountries = (row.coveragecountries ?? "")
        .split(/[|;]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!/^[A-Z]{2}$/.test(countryIso2)) { rowErrors.push(`Line ${line}: invalid countryIso2 '${countryIso2 || '(empty)'}'`); continue; }
      if (isRestrictedPlanCountry(countryIso2)) { rowErrors.push(`Line ${line}: destination country '${countryIso2}' is not supported`); continue; }
      if (!name) { rowErrors.push(`Line ${line}: name is required`); continue; }
      if (!providerPlanId) { rowErrors.push(`Line ${line}: providerPlanId is required`); continue; }
      if (!dataAllowance) { rowErrors.push(`Line ${line}: dataAllowance is required`); continue; }
      if (validityDays === null || !Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650) { rowErrors.push(`Line ${line}: validityDays must be a whole number between 1 and 3650`); continue; }
      if (!Number.isFinite(costPrice) || costPrice < 0 || costPrice > 9999999999.99) { rowErrors.push(`Line ${line}: costPrice must be a non-negative number`); continue; }
      if (!Number.isFinite(sellingPrice) || sellingPrice < 0 || sellingPrice > 9999999999.99) { rowErrors.push(`Line ${line}: sellingPrice must be a non-negative number`); continue; }
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
          popular,
          status,
          coverage,
        };
        if (existing) {
          const effectiveStatus =
            (row.status ?? "").trim().toUpperCase()
              ? status
              : existing.status === PlanStatus.ACTIVE
                ? PlanStatus.ACTIVE
                : status;
          await this.prisma.plan.update({
            where: { id: existing.id },
            data: { ...data, status: effectiveStatus },
          });
          updated++;
        } else {
          await this.prisma.plan.create({
            data: { countryId: country.id, providerPlanId, ...data },
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
          newValue: { imported, updated, skipped: rowErrors.length, fileName: fileName ?? null },
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
    if (unit === "month" || unit === "months" || unit === "mo") return amount * 30;
    return amount;
  }

  integrations() {
    const configured = (keys: string[]) =>
      keys.every((key) => Boolean(process.env[key]));
    return [
      {
        id: "email",
        name: "Email (Gmail OAuth)",
        category: "NOTIFICATION",
        provider: "GMAIL",
        enabled:
          process.env.NOTIFICATION_MODE === "live" &&
          configured([
            "GMAIL_CLIENT_ID",
            "GMAIL_CLIENT_SECRET",
            "GMAIL_REFRESH_TOKEN",
          ]),
        status:
          process.env.NOTIFICATION_MODE === "live" &&
          configured([
            "GMAIL_CLIENT_ID",
            "GMAIL_CLIENT_SECRET",
            "GMAIL_REFRESH_TOKEN",
          ])
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
        id: "cloudinary",
        name: "Private Document Storage",
        category: "STORAGE",
        provider: "CLOUDINARY",
        enabled: configured([
          "CLOUDINARY_CLOUD_NAME",
          "CLOUDINARY_API_KEY",
          "CLOUDINARY_API_SECRET",
        ]),
        status: configured([
          "CLOUDINARY_CLOUD_NAME",
          "CLOUDINARY_API_KEY",
          "CLOUDINARY_API_SECRET",
        ])
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

  testIntegration(id: string) {
    const item = this.integrations().find(
      (integration) => integration.id === id,
    );
    if (!item) throw new NotFoundException("Integration not found");
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

  /**
   * Fetches the Transatel catalog and renders it as a CSV report that can be
   * edited and re-imported via the plans import endpoint. Column order matches
   * the expected import headers (see importPlansFromTabular).
   */
  async exportTransatelCatalog(cos?: string) {
    this.requireTransatel();
    const { rows, skipped } = await this.connectivity.catalogReport(cos?.trim() || undefined);
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
      "status",
    ] as const;
    const renderRow = (row: Record<string, unknown>) =>
      columns.map((column) => this.csvCell(row[column])).join(",");
    const csv = [
      columns.join(","),
      ...rows.map((row) =>
        renderRow({
          ...row,
          coveragecountries: row.coveragecountries,
        }),
      ),
    ].join("\n");
    return {
      fileName: `transatel-catalog-${new Date().toISOString().slice(0, 10)}.csv`,
      count: rows.length,
      skipped: skipped.length,
      skippedIds: skipped,
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

  async users(input: { q?: string; accountType?: UserRoleName; status?: UserStatus; limit?: number; offset?: number } = {}) {
    if (!this.prisma.enabled) return { items: [], total: 0, limit: 50, offset: 0 };
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    const where = { ...(input.q?.trim() ? { OR: [{ email: { contains: input.q.trim(), mode: "insensitive" as const } }, { clerkId: { contains: input.q.trim(), mode: "insensitive" as const } }, { customer: { is: { customerCode: { contains: input.q.trim(), mode: "insensitive" as const } } } }] } : {}), ...(input.accountType ? { accountType: input.accountType } : {}), ...(input.status ? { status: input.status } : {}) };
    const [users, total] = await Promise.all([this.prisma.user.findMany({
      where,
      include: { roles: { include: { role: true } }, customer: true },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }), this.prisma.user.count({ where })]);
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
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60_000);
    const temporaryPassword = randomBytes(9).toString("base64url");
    const invitation = await this.prisma.staffInvitation.create({
      data: {
        email,
        accountType,
        invitedById: inviter.id,
        expiresAt,
      },
    });
    try {
      const clerk = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      const created = await clerk.users.createUser({
        emailAddress: [email],
        password: temporaryPassword,
        skipPasswordChecks: true,
        publicMetadata: { accountType },
      });
      await this.prisma.staffInvitation.update({
        where: { id: invitation.id },
        data: { clerkInvitationId: created.id },
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
    return { ...invitation, temporaryPassword };
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
    const old = await this.prisma.staffInvitation.findUnique({ where: { id } });
    if (!old) throw new NotFoundException("Invitation not found");
    if (old.status === StaffInvitationStatus.ACCEPTED)
      throw new BadRequestException("Invitation was already accepted");
    if (!process.env.CLERK_SECRET_KEY || !old.clerkInvitationId)
      throw new BadRequestException("Clerk is not configured");
    const temporaryPassword = randomBytes(9).toString("base64url");
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    await clerk.users.updateUser(old.clerkInvitationId, {
      password: temporaryPassword,
      skipPasswordChecks: true,
    });
    await this.prisma.user.updateMany({
      where: { clerkId: old.clerkInvitationId },
      data: { mustChangePassword: true },
    });
    return { ...old, temporaryPassword };
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
    return (await this.users({ limit: 200 })).items.find((item) => item.id === userId);
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
