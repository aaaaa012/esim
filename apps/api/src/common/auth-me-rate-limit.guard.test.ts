import { HttpException, HttpStatus } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthMeRateLimitGuard } from "./auth-me-rate-limit.guard.js";

function context(userId: string, ip: string) {
  const headers = new Map<string, string | number>();
  return {
    headers,
    value: { switchToHttp: () => ({
      getRequest: () => ({ user: { id: userId, localUserId: userId }, ip, headers: {} }),
      getResponse: () => ({ setHeader: (name: string, value: string | number) => headers.set(name, value) }),
    }) } as never,
  };
}

describe("AuthMeRateLimitGuard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("isolates users sharing one IP until the secondary ceiling", async () => {
    vi.stubEnv("AUTH_ME_RATE_LIMIT_PER_MINUTE", "2");
    vi.stubEnv("AUTH_ME_IP_RATE_LIMIT_PER_MINUTE", "10");
    const guard = new AuthMeRateLimitGuard();
    await expect(guard.canActivate(context("user-a", "1.2.3.4").value)).resolves.toBe(true);
    await expect(guard.canActivate(context("user-a", "1.2.3.4").value)).resolves.toBe(true);
    await expect(guard.canActivate(context("user-a", "1.2.3.4").value)).rejects.toBeInstanceOf(HttpException);
    await expect(guard.canActivate(context("user-b", "1.2.3.4").value)).resolves.toBe(true);
  });

  it("does not let one user bypass its limit by changing IP", async () => {
    vi.stubEnv("AUTH_ME_RATE_LIMIT_PER_MINUTE", "1");
    vi.stubEnv("AUTH_ME_IP_RATE_LIMIT_PER_MINUTE", "10");
    const guard = new AuthMeRateLimitGuard();
    await expect(guard.canActivate(context("user-a", "1.2.3.4").value)).resolves.toBe(true);
    const blocked = context("user-a", "5.6.7.8");
    await expect(guard.canActivate(blocked.value)).rejects.toBeInstanceOf(HttpException);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("fails closed when the shared production counter is unavailable", async () => {
    const queues = { enabled: true, consumeRateLimit: vi.fn().mockRejectedValue(new Error("redis unavailable")) };
    const guard = new AuthMeRateLimitGuard(queues as never);
    await expect(guard.canActivate(context("user-a", "1.2.3.4").value)).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
  });
});
