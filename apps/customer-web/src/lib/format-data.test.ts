import { describe, expect, it } from "vitest";
import { formatDataMb, formatPlanDataText } from "./format-data";

describe("customer data display", () => {
  it("shows numeric allowances in GB", () => {
    expect(formatDataMb(500)).toBe("500 MB");
    expect(formatDataMb(1024)).toBe("1 GB");
    expect(formatDataMb(1536)).toBe("1.5 GB");
  });

  it("converts MB tokens embedded in customer-facing plan text", () => {
    expect(formatPlanDataText("One-Off USA 500MB 1 day")).toBe(
      "One-Off USA 500 MB 1 day",
    );
    expect(formatPlanDataText("1024 MB / 7 days")).toBe("1 GB / 7 days");
    expect(formatPlanDataText("Unlimited data")).toBe("Unlimited data");
  });
});
