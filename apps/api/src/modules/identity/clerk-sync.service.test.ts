import { afterEach, describe, expect, it, vi } from "vitest";
import { UserRoleName, UserStatus } from "@prisma/client";
import { ClerkSyncService } from "./clerk-sync.service.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";

function prismaStub(overrides: Record<string, unknown> = {}) {
  const user = {
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: "new-user" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0),
  };
  const base = {
    enabled: true,
    user,
    role: {
      upsert: vi.fn().mockResolvedValue({ id: "role-1" }),
    },
    userRole: {
      create: vi.fn().mockResolvedValue({}),
    },
    customer: {
      create: vi.fn().mockResolvedValue({}),
    },
    staffInvitation: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (cb) => cb(base)),
  };
  return { ...base, ...overrides } as unknown as PrismaService;
}

const createdEvent = (clerkId: string, email: string) => ({
  type: "user.created" as const,
  data: {
    id: clerkId,
    email_addresses: [
      {
        id: "ea-1",
        email_address: email,
        verification: { status: "verified" },
      },
    ],
    primary_email_address_id: "ea-1",
  },
});

describe("ClerkSyncService re-registration recovery", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("re-activates a DISABLED account that owns the email instead of failing on the unique email constraint", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "");
    const disabled = {
      id: "user-1",
      clerkId: "old-clerk-id",
      email: "user@example.com",
      accountType: UserRoleName.CUSTOMER,
      status: UserStatus.DISABLED,
    };
    const prisma = prismaStub();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { clerkId?: string; email?: string } }) =>
        Promise.resolve(
          args.where.clerkId
            ? null
            : args.where.email === "user@example.com"
              ? disabled
              : null,
        ),
    );
    const service = new ClerkSyncService(prisma);

    const result = await service.sync(createdEvent("new-clerk-id", "user@example.com"));

    expect(result.persisted).toBe(true);
    expect(result.accountType).toBe(UserRoleName.CUSTOMER);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        clerkId: "new-clerk-id",
        email: "user@example.com",
        status: UserStatus.ACTIVE,
      },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("still creates a new CUSTOMER when the email is not taken", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "");
    const prisma = prismaStub();
    const service = new ClerkSyncService(prisma);

    const result = await service.sync(createdEvent("brand-new", "fresh@example.com"));

    expect(result.persisted).toBe(true);
    expect(result.accountType).toBe(UserRoleName.CUSTOMER);
    expect(prisma.user.create).toHaveBeenCalled();
  });
});
