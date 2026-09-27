import { describe, expect, it } from "vitest";
import { operationalIssue } from "./operational-issue";

describe("operationalIssue", () => {
  it("turns Transatel subscriber eligibility JSON into actionable staff copy", () => {
    const issue = operationalIssue(
      JSON.stringify({
        title: "SUBSCRIBER_STATUS_NOT_ELIGIBLE",
        detail: "Order failed - Subscriber status is not compatible with the order",
      }),
    );
    expect(issue.title).toBe("eSIM is not eligible for a top-up");
    expect(issue.action).toContain("Do not charge the customer again");
    expect(JSON.stringify(issue)).not.toContain("Order failed");
  });

  it("does not expose an unknown raw provider response", () => {
    const issue = operationalIssue("secret internal provider response", "OTHER");
    expect(issue.summary).not.toContain("secret internal provider response");
    expect(issue.summary).toContain("Integration logs");
  });
});
