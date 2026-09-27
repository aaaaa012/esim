import { describe, expect, it } from "vitest";
import { lifecycleApprovalMessage } from "./transatel-dashboard";

describe("Transatel lifecycle approval visibility", () => {
  it("confirms to the requester that their approval request was sent", () => {
    expect(
      lifecycleApprovalMessage(
        { state: "APPROVAL_REQUIRED", requesterId: "requester-1" },
        "requester-1",
      ),
    ).toBe("Request sent · awaiting another Super Admin");
  });

  it("shows other administrators that the request awaits a decision", () => {
    expect(
      lifecycleApprovalMessage(
        { state: "APPROVAL_REQUIRED", requesterId: "requester-1" },
        "approver-2",
      ),
    ).toBe("Awaiting another Super Admin");
  });

  it("does not describe terminal operations as awaiting approval", () => {
    expect(
      lifecycleApprovalMessage(
        { state: "REJECTED", requesterId: "requester-1" },
        "requester-1",
      ),
    ).toBeNull();
  });
});
