import { expect, test } from "@playwright/test";

const planId = "11111111-1111-4111-8111-111111111111";
const secret = "local-e2e-auth-secret-at-least-32-characters";
const consent = {
  planId,
  compatibilityAccepted: true,
  termsAccepted: true,
  privacyAccepted: true,
};

test("guest purchase creates private recoverable state", async ({ request }) => {
  const created = await request.post("guest/orders", {
    data: { ...consent, email: "guest@example.com" },
  });
  expect(created.status()).toBe(201);
  const payload = (await created.json()).data;
  expect(payload.order).toMatchObject({
    status: "DRAFT",
    purchaseType: "INITIAL_PURCHASE",
    plan: { id: planId },
  });
  expect(payload.token).toEqual(expect.any(String));
  expect(payload.recovery.token).toEqual(expect.any(String));

  const forbidden = await request.get(`guest/orders/${payload.order.id}`, {
    headers: { "x-guest-order-token": "invalid" },
  });
  expect(forbidden.status()).toBe(403);
  const privateView = await request.get(`guest/orders/${payload.order.id}`, {
    headers: { "x-guest-order-token": payload.token },
  });
  expect(privateView.ok()).toBe(true);
  expect((await privateView.json()).data.id).toBe(payload.order.id);
});

test("customer purchase is owned and isolated by authenticated identity", async ({ request }) => {
  const customerToken = `${secret}:CUSTOMER`;
  const created = await request.post("customer/orders", {
    headers: { authorization: `Bearer ${customerToken}` },
    data: consent,
  });
  expect(created.status()).toBe(201);
  const order = (await created.json()).data;
  expect(order).toMatchObject({
    status: "DRAFT",
    purchaseType: "INITIAL_PURCHASE",
    plan: { id: planId },
  });
  const listed = await request.get("customer/orders", {
    headers: { authorization: `Bearer ${customerToken}` },
  });
  expect((await listed.json()).data).toEqual([
    expect.objectContaining({ id: order.id }),
  ]);
  const opsCannotUseCustomerRoute = await request.get("customer/orders", {
    headers: { authorization: `Bearer ${secret}:OPERATIONS` },
  });
  expect(opsCannotUseCustomerRoute.status()).toBe(403);
});
