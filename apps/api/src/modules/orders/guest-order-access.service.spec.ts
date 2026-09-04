import { ForbiddenException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../infrastructure/prisma.service.js";
import { GuestOrderAccessService } from "./guest-order-access.service.js";

const createService = () =>
  new GuestOrderAccessService({ enabled: false } as PrismaService);

const originalEnvironment = process.env.NODE_ENV;
const originalSecret = process.env.GUEST_ORDER_SECRET;

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
  if (originalSecret === undefined) delete process.env.GUEST_ORDER_SECRET;
  else process.env.GUEST_ORDER_SECRET = originalSecret;
});

describe("GuestOrderAccessService", () => {
  it("binds signed session tokens to one order and rejects tampering", () => {
    process.env.GUEST_ORDER_SECRET = "test-secret-with-enough-entropy";
    const service = createService();
    const token = service.createSessionToken("order-a");

    expect(() => service.assertSessionToken("order-a", token)).not.toThrow();
    expect(() => service.assertSessionToken("order-b", token)).toThrow(
      ForbiddenException,
    );
    expect(() =>
      service.assertSessionToken("order-a", `${token.slice(0, -1)}x`),
    ).toThrow(ForbiddenException);
  });

  it("stores only a digest-equivalent handle and revokes recovery access", async () => {
    process.env.GUEST_ORDER_SECRET = "test-secret-with-enough-entropy";
    const service = createService();
    const issued = await service.issue("order-a", "DISPLAY");

    expect(issued?.token).toBeTruthy();
    await expect(service.recover("order-b", issued!.token)).rejects.toThrow(
      ForbiddenException,
    );
    const recovered = await service.recover("order-a", issued!.token);
    expect(() =>
      service.assertSessionToken("order-a", recovered.token),
    ).not.toThrow();

    await service.revokeAll("order-a");
    await expect(service.recover("order-a", issued!.token)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("deduplicates recovery email for the same recipient and rotates on change", async () => {
    const service = createService();
    const first = await service.issue("order-a", "EMAIL", "A@Example.com");
    const duplicate = await service.issue(
      "order-a",
      "EMAIL",
      " a@example.com ",
    );
    const replacement = await service.issue(
      "order-a",
      "EMAIL",
      "b@example.com",
    );

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(replacement).not.toBeNull();
    await expect(service.recover("order-a", first!.token)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.recover("order-a", replacement!.token),
    ).resolves.toMatchObject({ recoveryExpiresAt: replacement!.expiresAt });
  });

  it("fails closed when production has no configured signing secret", () => {
    process.env.NODE_ENV = "production";
    delete process.env.GUEST_ORDER_SECRET;
    const service = createService();

    expect(() => service.createSessionToken("order-a")).toThrow(
      "GUEST_ORDER_SECRET is required in production",
    );
  });

  it("binds a top-up lookup token to its MSISDN and rejects tampering", () => {
    process.env.GUEST_ORDER_SECRET = "test-secret-with-enough-entropy";
    const service = createService();
    const token = service.createLookupToken("+9779800000000");

    expect(service.mobileFromLookupToken(token)).toBe("+9779800000000");
    expect(() =>
      service.mobileFromLookupToken(`${token.slice(0, -1)}x`),
    ).toThrow(ForbiddenException);
  });

  it("rejects an expired top-up lookup token", () => {
    process.env.GUEST_ORDER_SECRET = "test-secret-with-enough-entropy";
    const service = createService();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const token = service.createLookupToken("+9779800000000");
    clock.mockReturnValue(now + 15 * 60_000 + 1);

    expect(() => service.mobileFromLookupToken(token)).toThrow(
      ForbiddenException,
    );
    clock.mockRestore();
  });
});
