import { describe, expect, it } from "vitest";
import { publicApiErrorMessage } from "./errors.js";

describe("publicApiErrorMessage", () => {
  it("maps known codes to approved customer copy", () => {
    expect(publicApiErrorMessage({ code: "RATE_LIMITED" })).toContain(
      "Too many attempts",
    );
  });

  it("never renders provider detail or a correlation identifier", () => {
    const unsafe = {
      code: "CLERK_ACTIVATION_FAILED",
      message: "form_data_missing correlationId=secret-reference",
    };
    expect(
      publicApiErrorMessage(unsafe, "Unable to complete the request."),
    ).toBe("Unable to complete the request.");
  });

  it("provides actionable copy for rejected eSIM lifecycle actions", () => {
    expect(publicApiErrorMessage({ code: "ESIM_LIFECYCLE_NOT_ALLOWED" })).toBe(
      "This action is not available for the eSIM's current network status.",
    );
  });

  it("tells customers to reload after an order conflict", () => {
    expect(publicApiErrorMessage({ code: "ORDER_CONFLICT" })).toMatch(/reload/i);
    expect(publicApiErrorMessage({ code: "HTTP_409" })).toMatch(/reload/i);
  });

  it("explains why traveller details are locked during review", () => {
    expect(publicApiErrorMessage({ code: "TRAVELER_REVIEW_LOCKED" })).toMatch(/review/i);
  });

  it("explains a contact-to-eSIM conflict with a recharge next step", () => {
    expect(publicApiErrorMessage({ code: "ESIM_CONTACT_ALREADY_LINKED" })).toMatch(/recharge/i);
    expect(publicApiErrorMessage({ code: "NEPAL_CONTACT_REQUIRED" })).toMatch(/Nepal mobile/i);
  });
});
