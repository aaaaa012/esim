import { expect, test } from "@playwright/test";

const secret = "local-e2e-auth-secret-at-least-32-characters";

test("local API runtime is healthy without database or Redis", async ({ request }) => {
  const response = await request.get("health/ready");
  expect(response.ok()).toBe(true);
  expect((await response.json()).data).toMatchObject({
    status: "ready",
    checks: { api: "up", database: "not-configured", redis: "not-configured" },
  });
});

test("local authentication supports roles and fails closed", async ({ request }) => {
  const unauthorized = await request.get("auth/me");
  expect(unauthorized.status()).toBe(401);
  const wrong = await request.get("auth/me", {
    headers: { authorization: `Bearer wrong:${"CUSTOMER"}` },
  });
  expect(wrong.status()).toBe(401);
  for (const role of ["CUSTOMER", "OPERATIONS", "SUPER_ADMIN"] as const) {
    const response = await request.get("auth/me", {
      headers: { authorization: `Bearer ${secret}:${role}` },
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).data.accountType).toBe(role);
  }
});

test("local catalogue provides deterministic purchasable plans", async ({ request }) => {
  const countries = await request.get("public/countries");
  expect(countries.ok()).toBe(true);
  expect((await countries.json()).data).toEqual([
    { code: "AU", name: "Australia", popular: false },
    { code: "IN", name: "India", popular: true },
  ]);
  const plans = await request.get("public/plans?country=IN");
  expect(plans.ok()).toBe(true);
  expect((await plans.json()).data).toEqual([
    expect.objectContaining({
      id: "11111111-1111-4111-8111-111111111111",
      allowanceMb: 1024,
    }),
  ]);
});
