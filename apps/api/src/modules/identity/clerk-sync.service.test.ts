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
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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

    const result = await service.sync(
      createdEvent("new-clerk-id", "user@example.com"),
    );

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

  it("relinks an ACTIVE account when Clerk recreates the same verified email with a new user id", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "");
    const active = {
      id: "admin-1",
      clerkId: "old-clerk-id",
      email: "admin@example.com",
      accountType: UserRoleName.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    };
    const prisma = prismaStub();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { clerkId?: string; email?: string } }) =>
        Promise.resolve(
          args.where.clerkId
            ? null
            : args.where.email === "admin@example.com"
              ? active
              : null,
        ),
    );
    const service = new ClerkSyncService(prisma);

    const result = await service.sync(
      createdEvent("new-clerk-id", "admin@example.com"),
    );

    expect(result).toEqual({
      persisted: true,
      accountType: UserRoleName.SUPER_ADMIN,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      data: {
        clerkId: "new-clerk-id",
        email: "admin@example.com",
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

    const result = await service.sync(
      createdEvent("brand-new", "fresh@example.com"),
    );

    expect(result.persisted).toBe(true);
    expect(result.accountType).toBe(UserRoleName.CUSTOMER);
    expect(prisma.user.create).toHaveBeenCalled();
  });
});

describe("ClerkSyncService bootstrap (token-verified)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const customerUser = {
    id: "user-1",
    clerkId: "clerk-1",
    email: "founder@visacompassnepal.com",
    accountType: UserRoleName.CUSTOMER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
    customer: null,
  };

  it("promotes the bootstrap email when the token matches", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "founder@visacompassnepal.com");
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_TOKEN", "topsecret");
    vi.stubEnv("NODE_ENV", "production");
    const prisma = prismaStub();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      customerUser,
    );
    const service = new ClerkSyncService(prisma);

    const result = await service.bootstrapSuperAdmin("clerk-1", "topsecret");

    expect(result.promoted).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        accountType: UserRoleName.SUPER_ADMIN,
        mustChangePassword: false,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "BOOTSTRAP_SUPER_ADMIN" }),
      }),
    );
  });

  it("rejects a wrong token and audits the attempt", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "founder@visacompassnepal.com");
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_TOKEN", "topsecret");
    vi.stubEnv("NODE_ENV", "production");
    const prisma = prismaStub();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      customerUser,
    );
    const service = new ClerkSyncService(prisma);

    await expect(
      service.bootstrapSuperAdmin("clerk-1", "wrong"),
    ).rejects.toThrow();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "BOOTSTRAP_TOKEN_REJECTED" }),
      }),
    );
  });

  it("refuses bootstrap once a Super Admin already exists", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "founder@visacompassnepal.com");
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_TOKEN", "topsecret");
    vi.stubEnv("NODE_ENV", "production");
    const prisma = prismaStub();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      customerUser,
    );
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const service = new ClerkSyncService(prisma);

    await expect(
      service.bootstrapSuperAdmin("clerk-1", "topsecret"),
    ).rejects.toThrow("already exists");
  });
});

describe("ClerkSyncService last-super-admin recovery", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("audits an identity emergency when the last active Super Admin is deleted in Clerk", async () => {
    vi.stubEnv("BOOTSTRAP_SUPER_ADMIN_EMAIL", "");
    vi.stubEnv("OPS_ALERT_EMAIL", "");
    const deleted = {
      id: "user-1",
      clerkId: "clerk-1",
      email: "admin@visacompassnepal.com",
      accountType: UserRoleName.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    };
    const prisma = prismaStub();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      deleted,
    );
    (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const service = new ClerkSyncService(prisma);

    const result = await service.sync({
      type: "user.deleted",
      data: { id: "clerk-1" },
    });

    expect(result.persisted).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "LAST_SUPER_ADMIN_IDENTITY_DELETED",
        }),
      }),
    );
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clerkId: "clerk-1" },
        data: { status: UserStatus.DISABLED },
      }),
    );
  });
});
