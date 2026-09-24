import { describe, expect, it, vi } from "vitest";
import { GuestOrdersController } from "./guest-orders.controller.js";

describe("guest passport confirmation", () => {
  it("authorizes the guest token and sends confirmed mismatches to manual review", async () => {
    const order = {
      id: "guest-order",
      ownerId: null,
      purchaseType: "INITIAL_PURCHASE",
    };
    const orders = {
      refreshOne: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue(order),
      confirmPassportDetails: vi.fn().mockResolvedValue({
        ...order,
        documentReviewStatus: "MANUAL_REVIEW",
      }),
    };
    const access = { assertSessionToken: vi.fn() };
    const controller = new GuestOrdersController(
      orders as never,
      {} as never,
      {} as never,
      access as never,
      {} as never,
      {} as never,
    );

    const result = await controller.confirmPassportDetails(
      "guest-order",
      "guest-token",
    );

    expect(access.assertSessionToken).toHaveBeenCalledWith(
      "guest-order",
      "guest-token",
    );
    expect(orders.confirmPassportDetails).toHaveBeenCalledWith(
      "guest-order",
      null,
    );
    expect(result.documentReviewStatus).toBe("MANUAL_REVIEW");
  });
});
