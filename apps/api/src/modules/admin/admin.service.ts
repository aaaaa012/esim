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
import { createClerkClient } from "@clerk/backend";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

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
        id: "auriga",
        name: "Auriga Connectivity",
        category: "CONNECTIVITY",
        provider: "AURIGA MOCK",
        enabled: true,
        status: "HEALTHY",
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
