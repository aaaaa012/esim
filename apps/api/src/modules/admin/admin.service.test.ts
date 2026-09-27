import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AdminService, mapClerkActivationFailure } from "./admin.service.js";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import type { ConnectivityService } from "../integration/connectivity.service.js";

const clerkClientMock = vi.hoisted(() => vi.fn());
vi.mock("@clerk/backend", () => ({ createClerkClient: clerkClientMock }));
afterEach(() => vi.unstubAllEnvs());

function prismaStub() {
  return {
    enabled: true,
    country: {
      upsert: vi.fn().mockResolvedValue({ id: "country-1" }),
    },
    plan: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function connectivityStub() {
  return {
    catalogReport: vi.fn().mockResolvedValue({ rows: [], skipped: [] }),
  } as unknown as ConnectivityService;
}

const headers = [
  "countryiso2,name,providerplanid,dataallowance,validitydays,costprice,sellingprice",
];

describe("mapClerkActivationFailure", () => {
  it("identifies missing Clerk profile data", () => {
    expect(
      mapClerkActivationFailure({
        status: 422,
        errors: [{ code: "form_data_missing" }],
      }),
    ).toMatchObject({
      code: "STAFF_PROFILE_INCOMPLETE",
      status: 422,
    });
  });

  it("identifies an existing Clerk identity", () => {
    expect(
      mapClerkActivationFailure({
        status: 422,
        errors: [{ code: "form_identifier_exists" }],
      }),
    ).toMatchObject({ code: "STAFF_IDENTITY_EXISTS", status: 422 });
  });

  it("identifies a password-policy rejection", () => {
    expect(
      mapClerkActivationFailure({
        errors: [{ code: "form_password_pwned" }],
      }).code,
    ).toBe("STAFF_PASSWORD_REJECTED");
  });

  it("identifies rate limiting", () => {
    expect(mapClerkActivationFailure({ status: 429 }).code).toBe(
      "STAFF_ACTIVATION_RATE_LIMITED",
    );
  });

  it("does not expose unknown provider messages", () => {
    const result = mapClerkActivationFailure({
      status: 500,
      errors: [{ code: "unexpected", longMessage: "provider secret" }],
    });
    expect(result.code).toBe("STAFF_ACTIVATION_FAILED");
    expect(result.message).not.toContain("provider secret");
  });
});

describe("AdminService document review policy persistence", () => {
  it("returns defaults without writing when the singleton row is absent", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = {
      enabled: true,
      platformConfiguration: { findUnique },
    } as unknown as PrismaService;
    const admin = new AdminService(prisma, connectivityStub());

    await expect(admin.documentReviewPolicy()).resolves.toEqual({
      policy: "AUTO_OCR",
      ocrCheckoutWaitMs: 8000,
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("updates configuration and writes its audit record atomically", async () => {
    const actor = { id: "admin-1", clerkId: "clerk-admin-1" };
    const tx = {
      platformConfiguration: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({
          id: "platform",
          documentReviewPolicy: "MANUAL_REVIEW",
          ocrCheckoutWaitMs: 12000,
          updatedAt: new Date("2026-09-22T00:00:00.000Z"),
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      enabled: true,
      user: { findUnique: vi.fn().mockResolvedValue(actor) },
      $transaction: vi.fn(
        async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
      ),
    } as unknown as PrismaService;
    const admin = new AdminService(prisma, connectivityStub());

    await expect(
      admin.updateDocumentReviewPolicy(
        { policy: "MANUAL_REVIEW" as never, ocrCheckoutWaitMs: 12000 },
        actor.clerkId,
      ),
    ).resolves.toMatchObject({
      policy: "MANUAL_REVIEW",
      ocrCheckoutWaitMs: 12000,
    });
    expect(tx.platformConfiguration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          documentReviewPolicy: "MANUAL_REVIEW",
          ocrCheckoutWaitMs: 12000,
        }),
        create: expect.objectContaining({
          documentReviewPolicy: "MANUAL_REVIEW",
          ocrCheckoutWaitMs: 12000,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "DOCUMENT_REVIEW_POLICY_CHANGED",
          previousValue: {
            policy: "AUTO_OCR",
            ocrCheckoutWaitMs: 8000,
          },
        }),
      }),
    );
  });
});

describe("AdminService.correctCustomerEmail", () => {
  const customer = {
    id: "customer-1",
    email: "old@example.com",
    partnerIdentity: null,
    user: {
      id: "user-1",
      clerkId: "clerk-customer-1",
      email: "old@example.com",
      accountType: "CUSTOMER",
    },
  };
  const actor = {
    id: "admin-1",
    clerkId: "clerk-admin-1",
    accountType: "SUPER_ADMIN",
  };

  function correctionFixture(transactionFails = false) {
    const tx = {
      user: { update: vi.fn().mockResolvedValue({}) },
      customer: { update: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      enabled: true,
      user: {
        findUnique: vi
          .fn()
          .mockImplementation(({ where }) =>
            Promise.resolve(
              where.clerkId === actor.clerkId
                ? actor
                : where.email
                  ? null
                  : null,
            ),
          ),
      },
      customer: {
        findUnique: vi
          .fn()
          .mockImplementation(({ where }) =>
            Promise.resolve(where.id === customer.id ? customer : null),
          ),
      },
      $transaction: vi.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) => {
          if (transactionFails) throw new Error("database unavailable");
          return callback(tx);
        },
      ),
    } as unknown as PrismaService;
    const clerk = {
      users: {
        getUser: vi.fn().mockResolvedValue({
          primaryEmailAddressId: "email-old",
          emailAddresses: [
            { id: "email-old", emailAddress: "old@example.com" },
          ],
        }),
        updateUser: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        createEmailAddress: vi.fn().mockResolvedValue({
          id: "email-new",
          emailAddress: "new@example.com",
        }),
        deleteEmailAddress: vi.fn().mockResolvedValue({}),
      },
      sessions: {
        getSessionList: vi
          .fn()
          .mockResolvedValue({ data: [{ id: "session-1" }] }),
        revokeSession: vi.fn().mockResolvedValue({}),
      },
    };
    clerkClientMock.mockReturnValue(clerk);
    return { prisma, tx, clerk };
  }

  it("updates Clerk and both local identity records with an immutable audit entry", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test");
    const { prisma, tx, clerk } = correctionFixture();
    const admin = new AdminService(prisma, connectivityStub());

    await expect(
      admin.correctCustomerEmail(
        customer.id,
        "NEW@example.com",
        "Customer verified the corrected mailbox.",
        actor.clerkId,
      ),
    ).resolves.toMatchObject({
      changed: true,
      email: "new@example.com",
      sessionsFound: 1,
      sessionsRevoked: 1,
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: customer.user.id },
      data: { email: "new@example.com" },
    });
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: customer.id },
      data: { email: "new@example.com" },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "EMAIL_CORRECTED" }),
      }),
    );
    expect(clerk.sessions.revokeSession).toHaveBeenCalledWith("session-1");
  });

  it("restores the previous Clerk primary email when the local transaction fails", async () => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test");
    const { prisma, clerk } = correctionFixture(true);
    const admin = new AdminService(prisma, connectivityStub());

    await expect(
      admin.correctCustomerEmail(
        customer.id,
        "new@example.com",
        "Customer verified the corrected mailbox.",
        actor.clerkId,
      ),
    ).rejects.toThrow("rolled back");
    expect(clerk.users.updateUser).toHaveBeenLastCalledWith(
      customer.user.clerkId,
      expect.objectContaining({ primaryEmailAddressID: "email-old" }),
    );
    expect(clerk.emailAddresses.deleteEmailAddress).toHaveBeenCalledWith(
      "email-new",
    );
    expect(clerk.sessions.revokeSession).not.toHaveBeenCalled();
  });
});

function csv(validityDays: string, country = "IN") {
  return [
    ...headers,
    `${country},Travel 5GB,TRVL-5GB-15D,5120 MB,${validityDays},8,10`,
  ].join("\n");
}

describe("AdminService.importPlansFromTabular validity parsing", () => {
  it("accepts a plain integer of days", async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv("7"));
    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ validityDays: 7 }),
      }),
    );
  });

  it.each([
    ["7 days", 7],
    ["7days", 7],
    ["7D", 7],
    [" 14 days ", 14],
    ["1 months", 30],
    ["2 month", 60],
    ["3 mo", 90],
  ])('parses "%s" as %i days', async (value, days) => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv(value));
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ validityDays: days }),
      }),
    );
  });

  it.each(["", "soon", "7 hours", "three", "1.5 days"])(
    'rejects invalid validity "%s"',
    async (value) => {
      const prisma = prismaStub();
      const admin = new AdminService(prisma, connectivityStub());
      const result = await admin.importPlansFromTabular(csv(value));
      expect(result).toMatchObject({ imported: 0, skipped: 1 });
      expect(prisma.plan.create).not.toHaveBeenCalled();
    },
  );

  it("updates an existing plan when the provider plan already exists", async () => {
    const prisma = prismaStub();
    prisma.plan.findUnique = vi.fn().mockResolvedValue({ id: "plan-1" });
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv("7 days"));
    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plan-1" },
        data: expect.objectContaining({ validityDays: 7 }),
      }),
    );
  });

  it("rejects plans for restricted destination countries such as Nepal", async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv("7", "NP"));
    expect(result).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    expect(prisma.plan.create).not.toHaveBeenCalled();
    expect(prisma.country.upsert).not.toHaveBeenCalled();
  });
});

describe("AdminService.importPlansFromTabular role-based default status", () => {
  it("reports UPDATE_LISTED mode and never performs a missing-plan bulk update", async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.importPlansFromTabular(csv("7"));
    expect(result.mode).toBe("UPDATE_LISTED");
    expect(prisma.plan.updateMany).toBeUndefined();
  });

  it("rejects unsupported import modes", async () => {
    const admin = new AdminService(prismaStub(), connectivityStub());
    await expect(
      admin.importPlansFromTabular(
        csv("7"),
        "catalog.csv",
        undefined,
        "REPLACE_ACTIVE" as "UPDATE_LISTED",
      ),
    ).rejects.toThrow("Unsupported plan import mode");
  });

  it("imports as DRAFT when no actor is resolved", async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv("7"));
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT" }),
      }),
    );
  });

  it("imports as DRAFT when a SUPER_ADMIN does not explicitly request ACTIVE", async () => {
    const prisma = prismaStub();
    prisma.user.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "u-1", accountType: "SUPER_ADMIN" });
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv("7"), undefined, "clerk-1");
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT" }),
      }),
    );
  });

  it("imports as DRAFT when the actor is an OPERATIONS user", async () => {
    const prisma = prismaStub();
    prisma.user.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "u-2", accountType: "OPERATIONS" });
    const admin = new AdminService(prisma, connectivityStub());
    await admin.importPlansFromTabular(csv("7"), undefined, "clerk-2");
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT" }),
      }),
    );
  });

  it("keeps an explicit status column value", async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const fullHeaders =
      "countryiso2,countryname,name,providerplanid,dataallowance,validitydays,costprice,sellingprice,currency,coveragecountries,status";
    const explicit = `${fullHeaders}\nIN,India,Travel 5GB,TRVL-5GB-15D,5120 MB,7,8,10,NPR,IND,DISABLED`;
    await admin.importPlansFromTabular(explicit);
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DISABLED" }),
      }),
    );
  });

  it("round-trips an existing ACTIVE plan for an operations user", async () => {
    const prisma = prismaStub();
    prisma.user.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "u-2", accountType: "OPERATIONS" });
    prisma.plan.findUnique = vi
      .fn()
      .mockResolvedValue({ id: "plan-1", status: "ACTIVE" });
    const admin = new AdminService(prisma, connectivityStub());
    const fullHeaders =
      "countryiso2,name,providerplanid,dataallowance,validitydays,costprice,sellingprice,status";
    await admin.importPlansFromTabular(
      `${fullHeaders}\nIN,Travel 5GB,TRVL-5GB-15D,5120 MB,7,8,12,ACTIVE`,
      "catalog.csv",
      "clerk-2",
    );
    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sellingPrice: 12, status: "ACTIVE" }),
      }),
    );
  });

  it("defaults costPrice to sellingPrice when the cost column is blank", async () => {
    const prisma = prismaStub();
    const admin = new AdminService(prisma, connectivityStub());
    const blankCost = [
      ...headers,
      "IN,Travel 5GB,TRVL-5GB-15D,5120 MB,7,,10",
    ].join("\n");
    await admin.importPlansFromTabular(blankCost);
    expect(prisma.plan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ costPrice: 10, sellingPrice: 10 }),
      }),
    );
  });
});

describe("AdminService monthly catalogue reconciliation", () => {
  const plan = (
    id: string,
    providerPlanId: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    countryId: "country-1",
    country: { id: "country-1", isoCode: "IN", name: "India" },
    providerPlanId,
    name: `${providerPlanId} package`,
    dataAllowance: "1024 MB",
    validityDays: 7,
    costPrice: 700,
    sellingPrice: 999,
    currency: "NPR",
    coverage: ["India"],
    popular: false,
    status: "ACTIVE",
    providerMissingSince: null,
    lastCatalogSeenAt: null,
    ...overrides,
  });

  it("records unchanged, updated, missing and returned rows without duplicating plans", async () => {
    const prisma = prismaStub() as unknown as Record<string, any>;
    const same = plan("same", "SAME");
    const changed = plan("changed", "CHANGED");
    const returned = plan("returned", "RETURNED", {
      providerMissingSince: new Date("2026-08-01T00:00:00Z"),
      status: "DISABLED",
    });
    const missing = plan("missing", "MISSING");
    prisma.country.upsert.mockResolvedValue({ id: "country-1", name: "India" });
    prisma.plan.findMany.mockResolvedValue([same, changed, returned, missing]);
    prisma.plan.update.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id }),
    );
    prisma.catalogImportBatch = {
      create: vi.fn().mockResolvedValue({ id: "catalog-batch-1" }),
    };
    const input = [
      headers[0],
      "IN,SAME package,SAME,1024 MB,7,700,999",
      "IN,CHANGED package,CHANGED,1024 MB,7,750,1099",
      "IN,RETURNED package,RETURNED,1024 MB,7,700,999",
    ].join("\n");

    const result = await new AdminService(
      prisma as unknown as PrismaService,
      connectivityStub(),
    ).importPlansFromTabular(
      input,
      "september.csv",
      undefined,
      "FULL_CATALOG",
    );

    expect(result).toMatchObject({
      imported: 0,
      updated: 1,
      unchanged: 1,
      missing: 1,
      returned: 1,
      batchId: "catalog-batch-1",
    });
    expect(prisma.plan.create).not.toHaveBeenCalled();
    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "returned" },
        data: expect.objectContaining({
          status: "DRAFT",
          providerMissingSince: null,
        }),
      }),
    );
    expect(prisma.plan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "missing" },
        data: expect.objectContaining({
          providerMissingSince: expect.any(Date),
        }),
      }),
    );
    const rows = prisma.catalogImportBatch.create.mock.calls[0][0].data.rows
      .create as Array<{ change: string }>;
    expect(rows.map((row) => row.change).sort()).toEqual([
      "MISSING",
      "RETURNED",
      "UNCHANGED",
      "UPDATED",
    ]);
  });
});

describe("AdminService.exportOperatingCatalog", () => {
  const envKeys = [
    "TRANSATEL_BASE_URL",
    "TRANSATEL_CLIENT_ID",
    "TRANSATEL_CLIENT_SECRET",
    "TRANSATEL_MVNO_REF",
  ];
  const previous: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of envKeys) {
      previous[key] = process.env[key];
      process.env[key] = "configured";
    }
  });
  afterAll(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it("renders the catalog rows as a CSV report with import-compatible headers", async () => {
    const prisma = prismaStub();
    prisma.plan.findMany = vi.fn().mockResolvedValue([
      {
        country: { isoCode: "IN", name: "India" },
        name: "Travel 5GB",
        providerPlanId: "TRVL-5GB-15D",
        dataAllowance: "5120 MB",
        validityDays: 15,
        costPrice: 8,
        sellingPrice: 10,
        currency: "NPR",
        coverage: ["IND"],
        popular: true,
        status: "ACTIVE",
      },
    ] as never);
    const admin = new AdminService(prisma, connectivityStub());
    const result = await admin.exportOperatingCatalog();
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.csv).toContain(
      "countryiso2,countryname,name,providerplanid,dataallowance,validitydays,costprice,sellingprice,currency,coveragecountries,popular,status",
    );
    expect(result.csv).toContain(
      "IN,India,Travel 5GB,TRVL-5GB-15D,5120 MB,15,8,10,NPR,IND,true,ACTIVE",
    );
    expect(result.fileName).toMatch(
      /^visa-compass-catalog-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });

  it("downloads a fresh Transatel snapshot without reading or changing plans", async () => {
    const prisma = prismaStub();
    const connectivity = connectivityStub() as unknown as {
      catalogReport: ReturnType<typeof vi.fn>;
    };
    connectivity.catalogReport.mockResolvedValue({
      rows: [
        {
          countryiso2: "IN",
          countryname: "India",
          name: "Provider 1GB",
          providerplanid: "TSL-1GB",
          dataallowance: "1024 MB",
          validitydays: 7,
          costprice: 700,
          sellingprice: 700,
          currency: "NPR",
          coveragecountries: "IND",
          status: "",
        },
      ],
      skipped: ["INVALID-PRODUCT"],
    });
    const result = await new AdminService(
      prisma,
      connectivity as unknown as ConnectivityService,
    ).exportTransatelCatalog();
    expect(connectivity.catalogReport).toHaveBeenCalledOnce();
    expect(prisma.plan.findMany).not.toHaveBeenCalled();
    expect(prisma.plan.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ count: 1, skipped: 1 });
    expect(result.csv).toContain(
      "IN,India,Provider 1GB,TSL-1GB,1024 MB,7,700,700,NPR,IND,false",
    );
  });
});
