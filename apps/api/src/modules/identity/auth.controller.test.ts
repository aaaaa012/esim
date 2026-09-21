import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateUser } = vi.hoisted(() => ({ updateUser: vi.fn() }));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { updateUser } }),
}));

import { AuthController } from "./auth.controller.js";

describe("forced password change", () => {
  beforeEach(() => {
    vi.stubEnv("CLERK_SECRET_KEY", "sk_test_identity");
    updateUser.mockReset().mockResolvedValue({ id: "clerk-1" });
  });

  function setup(claimCount = 1) {
    const userUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: claimCount })
      .mockResolvedValue({ count: 1 });
    const txUserUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const prisma = {
      user: { updateMany: userUpdateMany },
      $transaction: vi.fn(async (work: (tx: unknown) => unknown) =>
        work({
          user: { updateMany: txUserUpdateMany },
          auditLog: { create: auditCreate },
        }),
      ),
    };
    const controller = new AuthController(prisma as never, {} as never);
    const request = {
      user: {
        id: "clerk-1",
        localUserId: "user-1",
      },
    };
    return {
      controller,
      request,
      userUpdateMany,
      txUserUpdateMany,
      auditCreate,
    };
  }

  it("changes the provider password before clearing the local gate", async () => {
    const { controller, request, txUserUpdateMany, auditCreate } = setup();
    await expect(
      controller.passwordChanged(request as never, {
        newPassword: "a-strong-new-password",
      }),
    ).resolves.toEqual({ ok: true });
    expect(updateUser).toHaveBeenCalledWith("clerk-1", {
      password: "a-strong-new-password",
      signOutOfOtherSessions: true,
    });
    expect(txUserUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mustChangePassword: true }),
        data: expect.objectContaining({ mustChangePassword: false }),
      }),
    );
    expect(auditCreate).toHaveBeenCalled();
  });

  it("does not clear the gate when the identity provider rejects the password", async () => {
    updateUser.mockRejectedValue(new Error("provider rejected"));
    const { controller, request, txUserUpdateMany } = setup();
    await expect(
      controller.passwordChanged(request as never, {
        newPassword: "a-strong-new-password",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_CHANGE_REJECTED" });
    expect(txUserUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects concurrent claims before contacting the identity provider", async () => {
    const { controller, request } = setup(0);
    await expect(
      controller.passwordChanged(request as never, {
        newPassword: "a-strong-new-password",
      }),
    ).rejects.toMatchObject({ code: "PASSWORD_CHANGE_IN_PROGRESS" });
    expect(updateUser).not.toHaveBeenCalled();
  });
});
