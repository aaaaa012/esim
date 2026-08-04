import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PlanStatus,
  StaffInvitationStatus,
  UserRoleName,
  UserStatus,
} from "@prisma/client";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { ConnectivityService } from "../integration/connectivity.service.js";
import { createClerkClient } from "@clerk/backend";
import { csvToRecords } from "../../common/csv.util.js";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService, private readonly connectivity: ConnectivityService) {}

  async plans() {
    if (!this.prisma.enabled) return [];
    return this.prisma.plan
      .findMany({
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

  async importPlansFromCsv(csv: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const { records, errors } = csvToRecords(csv, [
      "countryiso2",
      "name",
      "providerplanid",
      "dataallowance",
      "validitydays",
      "costprice",
      "sellingprice",
    ]);
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
      const validityDays = Number(row.validitydays);
      const costPrice = Number(row.costprice);
      const sellingPrice = Number(row.sellingprice);
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
          : PlanStatus.ACTIVE;
      const coverageCountries = (row.coveragecountries ?? "")
        .split(/[|;]/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!/^[A-Z]{2}$/.test(countryIso2)) { rowErrors.push(`Line ${line}: invalid countryIso2 '${countryIso2 || '(empty)'}'`); continue; }
      if (!name) { rowErrors.push(`Line ${line}: name is required`); continue; }
      if (!providerPlanId) { rowErrors.push(`Line ${line}: providerPlanId is required`); continue; }
      if (!dataAllowance) { rowErrors.push(`Line ${line}: dataAllowance is required`); continue; }
      if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650) { rowErrors.push(`Line ${line}: validityDays must be a whole number between 1 and 3650`); continue; }
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
          await this.prisma.plan.update({ where: { id: existing.id }, data });
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
    return {
      imported,
      updated,
      skipped: rowErrors.length,
      errors: rowErrors.slice(0, 100),
    };
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
        id: "esewa",
        name: "eSewa Payment Gateway",
        category: "PAYMENT",
        provider: "ESEWA",
        enabled: configured(["ESEWA_SECRET_KEY"]),
        status: configured(["ESEWA_SECRET_KEY"])
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
        enabled: configured(["WHATSAPP_TOKEN"]),
        status: configured(["WHATSAPP_TOKEN"]) ? "HEALTHY" : "CONFIG_REQUIRED",
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

  async users() {
    if (!this.prisma.enabled) return [];
    const users = await this.prisma.user.findMany({
      include: { roles: { include: { role: true } }, customer: true },
      orderBy: { createdAt: "desc" },
    });
    return users.map((user) => ({
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
  }

  async invitations() {
    if (!this.prisma.enabled) return [];
    return this.prisma.staffInvitation.findMany({
      include: { invitedBy: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
    });
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
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const created = await clerk.invitations.createInvitation({
      emailAddress: email,
      redirectUrl: `${process.env.OPS_WEB_URL ?? "http://localhost:3001"}/`,
      publicMetadata: { accountType },
    });
    const invitation = await this.prisma.staffInvitation.create({
      data: {
        email,
        accountType,
        invitedById: inviter.id,
        clerkInvitationId: created.id,
        expiresAt,
      },
    });
    await this.audit(inviter.id, "StaffInvitation", invitation.id, "CREATED", {
      email,
      accountType,
    });
    return invitation;
  }
  async revokeInvitation(id: string, actorClerkId: string) {
    const invitation = await this.prisma.staffInvitation.findUnique({
      where: { id },
    });
    if (!invitation) throw new NotFoundException("Invitation not found");
    if (invitation.status !== StaffInvitationStatus.PENDING)
      throw new BadRequestException("Invitation is not pending");
    if (invitation.clerkInvitationId && process.env.CLERK_SECRET_KEY)
      await createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY,
      }).invitations.revokeInvitation(invitation.clerkInvitationId);
    const actor = await this.prisma.user.findUnique({
      where: { clerkId: actorClerkId },
    });
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
    if (old.clerkInvitationId && process.env.CLERK_SECRET_KEY) {
      try {
        await createClerkClient({
          secretKey: process.env.CLERK_SECRET_KEY,
        }).invitations.revokeInvitation(old.clerkInvitationId);
      } catch {}
    }
    await this.prisma.staffInvitation.update({
      where: { id },
      data: { status: StaffInvitationStatus.REVOKED, revokedAt: new Date() },
    });
    return this.invite(old.email, old.accountType, actorClerkId);
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
    return (await this.users()).find((item) => item.id === userId);
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
