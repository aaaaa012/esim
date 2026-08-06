import { Injectable } from "@nestjs/common";
import {
  StaffInvitationStatus,
  UserRoleName,
  UserStatus,
} from "@prisma/client";
import { createClerkClient } from "@clerk/backend";
import { PrismaService } from "../../infrastructure/prisma.service.js";

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
  constructor(private readonly prisma: PrismaService) {}
  async sync(event: ClerkUserEvent) {
    if (!this.prisma.enabled) return { persisted: false };
    if (event.type === "user.deleted") {
      await this.prisma.user.updateMany({
        where: { clerkId: event.data.id },
        data: { status: UserStatus.DISABLED },
      });
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
      const accountType = await this.bootstrapExistingAccount(
        existing.id,
        email,
      );
      return {
        persisted: true,
        accountType: accountType ?? existing.accountType,
      };
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
      const accountType = await this.bootstrapExistingAccount(
        disabledWithSameEmail.id,
        email,
      );
      return {
        persisted: true,
        accountType: accountType ?? disabledWithSameEmail.accountType,
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
    let accountType = invitation?.accountType ?? UserRoleName.CUSTOMER;
    let bootstrapped = false;
    const bootstrapEmail =
      process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
    if (
      !invitation &&
      this.bootstrapEnabled(bootstrapEmail) &&
      bootstrapEmail === email &&
      (await this.prisma.user.count({
        where: {
          accountType: UserRoleName.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
        },
      })) === 0
    ) {
      accountType = UserRoleName.SUPER_ADMIN;
      bootstrapped = true;
    }
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { clerkId: event.data.id, email, accountType },
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
      if (bootstrapped)
        await tx.auditLog.create({
          data: {
            module: "IDENTITY",
            entity: "User",
            entityId: user.id,
            action: "BOOTSTRAP_SUPER_ADMIN",
            performedById: user.id,
            newValue: { email },
          },
        });
    });
    return { persisted: true, accountType };
  }
  async ensureUser(clerkId: string) {
    if (!this.prisma.enabled) return;
    const existing = await this.prisma.user.findUnique({ where: { clerkId } });
    if (existing) {
      await this.bootstrapExistingAccount(existing.id, existing.email);
      return;
    }
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

  private bootstrapEnabled(email?: string): boolean {
    if (!email) return false;
    if (process.env.NODE_ENV !== "production") return true;
    // In production the operator must additionally configure a bootstrap token
    // so that merely registering the configured email cannot self-appoint a
    // Super Admin.
    return Boolean(process.env.BOOTSTRAP_SUPER_ADMIN_TOKEN);
  }

  private async bootstrapExistingAccount(userId: string, email: string) {
    const bootstrapEmail =
      process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
    if (!this.bootstrapEnabled(bootstrapEmail) || !bootstrapEmail || bootstrapEmail !== email.toLowerCase()) return null;
    if (
      (await this.prisma.user.count({
        where: {
          accountType: UserRoleName.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
        },
      })) > 0
    )
      return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        customer: {
          include: { orders: { take: 1 }, esims: { take: 1 } },
        },
      },
    });
    if (!user || user.accountType !== UserRoleName.CUSTOMER) return null;
    if (user.customer?.orders.length || user.customer?.esims.length) {
      const alreadyFlagged = await this.prisma.auditLog.findFirst({
        where: {
          entity: "User",
          entityId: user.id,
          action: "BOOTSTRAP_REQUIRES_SEPARATE_STAFF_IDENTITY",
        },
      });
      if (!alreadyFlagged)
        await this.prisma.auditLog.create({
          data: {
            module: "IDENTITY",
            entity: "User",
            entityId: user.id,
            action: "BOOTSTRAP_REQUIRES_SEPARATE_STAFF_IDENTITY",
            performedById: user.id,
            newValue: { reason: "CUSTOMER_OWNS_BUSINESS_RECORDS" },
          },
        });
      return UserRoleName.CUSTOMER;
    }
    await this.prisma.$transaction(async (tx) => {
      if (user.customer)
        await tx.customer.delete({ where: { id: user.customer.id } });
      await tx.user.update({
        where: { id: user.id },
        data: { accountType: UserRoleName.SUPER_ADMIN },
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
          newValue: { source: "EXISTING_EMPTY_CUSTOMER" },
        },
      });
    });
    return UserRoleName.SUPER_ADMIN;
  }
}
