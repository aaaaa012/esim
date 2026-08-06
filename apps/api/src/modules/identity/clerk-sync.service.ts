import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  StaffInvitationStatus,
  UserRoleName,
  UserStatus,
} from "@prisma/client";
import { createClerkClient } from "@clerk/backend";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import { GmailChannel } from "../notification/gmail.channel.js";

type ClerkUserEvent = {
  type: "user.created" | "user.updated" | "user.deleted";
  data: {
    id: string;
    email_addresses?: {
      id: string;
      email_address: string;
      verification?: { status?: string };
    }[];
    primary_email_address_id?: string;
  };
};

@Injectable()
export class ClerkSyncService {
  private readonly logger = new Logger(ClerkSyncService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly gmail?: GmailChannel,
  ) {}
  async sync(event: ClerkUserEvent) {
    if (!this.prisma.enabled) return { persisted: false };
    if (event.type === "user.deleted") {
      await this.handleUserDeleted(event.data.id);
      return { persisted: true };
    }
    const verified = event.data.email_addresses?.filter(
      (item) => item.verification?.status === "verified",
    );
    const primary =
      verified?.find(
        (item) => item.id === event.data.primary_email_address_id,
      ) ?? verified?.[0];
    if (!primary) throw new Error("Clerk user event has no email address");
    const email = primary.email_address.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { clerkId: event.data.id },
    });
    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { email, status: UserStatus.ACTIVE },
      });
      return { persisted: true, accountType: existing.accountType };
    }
    const disabledWithSameEmail = await this.prisma.user.findUnique({
      where: { email },
    });
    if (disabledWithSameEmail && disabledWithSameEmail.status === UserStatus.DISABLED) {
      await this.prisma.user.update({
        where: { id: disabledWithSameEmail.id },
        data: {
          clerkId: event.data.id,
          email,
          status: UserStatus.ACTIVE,
        },
      });
      return {
        persisted: true,
        accountType: disabledWithSameEmail.accountType,
      };
    }
    const invitation = await this.prisma.staffInvitation.findFirst({
      where: {
        email,
        status: StaffInvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    const accountType = invitation?.accountType ?? UserRoleName.CUSTOMER;
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          clerkId: event.data.id,
          email,
          accountType,
          ...(invitation ? { mustChangePassword: true } : {}),
        },
      });
      const role = await tx.role.upsert({
        where: { name: accountType },
        update: {},
        create: { name: accountType },
      });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      if (accountType === UserRoleName.CUSTOMER)
        await tx.customer.create({
          data: {
            userId: user.id,
            email,
            customerCode: `VC-${user.id.slice(0, 8).toUpperCase()}`,
          },
        });
      if (invitation) {
        await tx.staffInvitation.update({
          where: { id: invitation.id },
          data: {
            status: StaffInvitationStatus.ACCEPTED,
            acceptedById: user.id,
            acceptedAt: new Date(),
          },
        });
        await tx.auditLog.create({
          data: {
            module: "IDENTITY",
            entity: "StaffInvitation",
            entityId: invitation.id,
            action: "ACCEPTED",
            performedById: user.id,
            newValue: { accountType, email },
          },
        });
      }
    });
    return { persisted: true, accountType };
  }
  async ensureUser(clerkId: string) {
    if (!this.prisma.enabled) return;
    const existing = await this.prisma.user.findUnique({ where: { clerkId } });
    if (existing) return;
    if (!process.env.CLERK_SECRET_KEY)
      throw new Error("Clerk server credentials are not configured");
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    const user = await clerk.users.getUser(clerkId);
    const emailAddresses = user.emailAddresses.map((item) => ({
      id: item.id,
      email_address: item.emailAddress,
      ...(item.verification?.status
        ? { verification: { status: String(item.verification.status) } }
        : {}),
    }));
    await this.sync({
      type: "user.created",
      data: {
        id: user.id,
        email_addresses: emailAddresses,
        ...((user.primaryEmailAddressId ?? emailAddresses[0]?.id)
          ? {
              primary_email_address_id:
                user.primaryEmailAddressId ?? emailAddresses[0]!.id,
            }
          : {}),
      },
    });
  }

  private async handleUserDeleted(clerkId: string) {
    const existing = await this.prisma.user.findUnique({
      where: { clerkId },
    });
    await this.prisma.user.updateMany({
      where: { clerkId },
      data: { status: UserStatus.DISABLED },
    });
    if (!existing) return;
    const wasActiveSuperAdmin =
      existing.accountType === UserRoleName.SUPER_ADMIN &&
      existing.status === UserStatus.ACTIVE;
    if (!wasActiveSuperAdmin) return;
    const remaining = await this.prisma.user.count({
      where: {
        accountType: UserRoleName.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    if (remaining > 0) {
      await this.prisma.auditLog.create({
        data: {
          module: "IDENTITY",
          entity: "User",
          entityId: existing.id,
          action: "SUPER_ADMIN_IDENTITY_DELETED",
          performedById: existing.id,
          newValue: { email: existing.email },
        },
      });
      return;
    }
    await this.prisma.auditLog.create({
      data: {
        module: "IDENTITY",
        entity: "User",
        entityId: existing.id,
        action: "LAST_SUPER_ADMIN_IDENTITY_DELETED",
        performedById: existing.id,
        newValue: {
          email: existing.email,
          note: "Zero active Super Admins remain. Bootstrap re-arms and requires the verified BOOTSTRAP_SUPER_ADMIN_TOKEN.",
        },
      },
    });
    await this.alertIdentityEmergency(
      `The last active Super Admin (${existing.email}) was deleted directly in Clerk. ` +
        `There are now zero active Super Admins. Recovery requires the verified BOOTSTRAP_SUPER_ADMIN_TOKEN.`,
    );
  }

  /**
   * Token-verified Super Admin bootstrap.
   *
   * The first Super Admin is created by calling POST /auth/bootstrap while
   * signed in with the account whose email equals BOOTSTRAP_SUPER_ADMIN_EMAIL.
   * Promotion only succeeds when:
   *   - no active Super Admin exists, and
   *   - the submitted token equals BOOTSTRAP_SUPER_ADMIN_TOKEN (constant-time
   *     comparison; in production the token is mandatory, in other environments
   *     it is optional for developer convenience), and
   *   - the account is not a customer identity that owns business records.
   * The endpoint is rate-limited and every attempt is audited.
   */
  async bootstrapSuperAdmin(clerkId: string, tokenInput: string) {
    if (!this.prisma.enabled)
      throw new BadRequestException("Database persistence is required");
    const bootstrapEmail = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
    if (!bootstrapEmail)
      throw new BadRequestException("Bootstrap is not configured");
    const configuredToken = process.env.BOOTSTRAP_SUPER_ADMIN_TOKEN?.trim() ?? "";
    const requiresToken = process.env.NODE_ENV === "production";
    if (requiresToken && !configuredToken)
      throw new BadRequestException("Bootstrap token is not configured");
    const user = await this.prisma.user.findUnique({
      where: { clerkId },
      include: {
        customer: {
          include: { orders: { take: 1 }, esims: { take: 1 } },
        },
      },
    });
    if (!user) throw new NotFoundException("Account not found");
    if (user.email.toLowerCase() !== bootstrapEmail)
      throw new ForbiddenException(
        "This account is not the configured bootstrap email",
      );
    if (
      user.accountType === UserRoleName.SUPER_ADMIN &&
      user.status === UserStatus.ACTIVE
    )
      return { promoted: false, alreadySuperAdmin: true };
    if (
      (await this.prisma.user.count({
        where: {
          accountType: UserRoleName.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
        },
      })) > 0
    )
      throw new ForbiddenException(
        "A Super Admin already exists; bootstrap is no longer available",
      );
    const verified =
      !requiresToken || this.constantTimeEqual(tokenInput, configuredToken);
    if (!verified) {
      await this.prisma.auditLog.create({
        data: {
          module: "IDENTITY",
          entity: "User",
          entityId: user.id,
          action: "BOOTSTRAP_TOKEN_REJECTED",
          performedById: user.id,
          newValue: { email: user.email },
        },
      });
      throw new ForbiddenException("Invalid bootstrap token");
    }
    if (user.customer?.orders.length || user.customer?.esims.length)
      throw new ConflictException(
        "This customer identity owns business records; bootstrap requires a separate staff identity",
      );
    await this.prisma.$transaction(async (tx) => {
      if (user.customer)
        await tx.customer.delete({ where: { id: user.customer.id } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          accountType: UserRoleName.SUPER_ADMIN,
          mustChangePassword: false,
        },
      });
      await tx.userRole.deleteMany({ where: { userId: user.id } });
      const role = await tx.role.upsert({
        where: { name: UserRoleName.SUPER_ADMIN },
        update: {},
        create: { name: UserRoleName.SUPER_ADMIN },
      });
      await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
      await tx.auditLog.create({
        data: {
          module: "IDENTITY",
          entity: "User",
          entityId: user.id,
          action: "BOOTSTRAP_SUPER_ADMIN",
          performedById: user.id,
          newValue: { source: "TOKEN_VERIFIED", email: user.email },
        },
      });
    });
    return { promoted: true, accountType: UserRoleName.SUPER_ADMIN };
  }

  private constantTimeEqual(provided: string, configured: string): boolean {
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(configured).digest();
    return timingSafeEqual(a, b);
  }

  private async alertIdentityEmergency(message: string) {
    const recipient = process.env.OPS_ALERT_EMAIL;
    if (recipient && this.gmail) {
      try {
        await this.gmail.send({
          to: recipient,
          subject: "[Ops Alert] Super Admin identity emergency",
          text: message,
        });
      } catch (error) {
        this.logger.error(
          `Identity emergency email failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      return;
    }
    this.logger.error(
      `IDENTITY_EMERGENCY: ${message} Configure OPS_ALERT_EMAIL to receive this alert by email.`,
    );
  }
}
