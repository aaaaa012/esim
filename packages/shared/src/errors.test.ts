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
});
