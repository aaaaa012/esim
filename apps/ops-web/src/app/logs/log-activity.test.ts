import { describe, expect, it } from "vitest";
import { activityLabel } from "./log-activity";

describe("activityLabel", () => {
  it("labels Khalti provider calls", () => {
    expect(
      activityLabel({
        group: "provider",
        identifier: "Khalti",
        title: "khalti-initiation",
      }),
    ).toBe("Khalti payment initiation");
  });

  it("labels Transatel provider calls", () => {
    expect(
      activityLabel({
        group: "provider",
        identifier: "Transatel",
        title: "subscriber-suspend",
      }),
    ).toBe("Transatel eSIM suspension");
  });

  it("labels incoming callbacks", () => {
    expect(
      activityLabel({
        group: "incoming",
        identifier: "Khalti",
        title: "khalti callback",
      }),
    ).toBe("Khalti payment callback received");
  });

  it("uses a generic label for unknown providers", () => {
    expect(
      activityLabel({
        group: "provider",
        identifier: "ExamplePay",
        title: "balance-check",
      }),
    ).toBe("ExamplePay service request");
  });
});
