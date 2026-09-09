import { describe, expect, it } from "vitest";
import { bullJobId } from "./queue.service.js";

describe("bullJobId", () => {
  it("preserves existing valid custom IDs", () => {
    expect(bullJobId("transatel-event-12345")).toBe(
      "transatel-event-12345",
    );
  });

  it("deterministically normalizes IDs rejected by BullMQ", () => {
    const colonId = bullJobId("transatel:event-12345");
    expect(colonId).toMatch(/^job-[a-f0-9]{64}$/);
    expect(colonId).toBe(bullJobId("transatel:event-12345"));
    expect(colonId).not.toContain(":");
    expect(bullJobId("12345")).toMatch(/^job-[a-f0-9]{64}$/);
  });
});
