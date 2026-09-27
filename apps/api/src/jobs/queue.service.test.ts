import { describe, expect, it } from "vitest";
import { bullJobId, decidePassportOcrRoute } from "./queue.service.js";

describe("bullJobId", () => {
  it("preserves existing valid custom IDs", () => {
    expect(bullJobId("transatel-event-12345")).toBe("transatel-event-12345");
  });

  it("deterministically normalizes IDs rejected by BullMQ", () => {
    const colonId = bullJobId("transatel:event-12345");
    expect(colonId).toMatch(/^job-[a-f0-9]{64}$/);
    expect(colonId).toBe(bullJobId("transatel:event-12345"));
    expect(colonId).not.toContain(":");
    expect(bullJobId("12345")).toMatch(/^job-[a-f0-9]{64}$/);
  });
});

describe("decidePassportOcrRoute", () => {
  const baseline = {
    mode: "hybrid" as const,
    waiting: 0,
    oldestAgeMs: 0,
    workerHealthy: true,
    waitingLimit: 2,
    maxAgeMs: 20_000,
  };

  it("keeps zero or one waiting job on local OCR", () => {
    expect(decidePassportOcrRoute(baseline).provider).toBe("tesseract");
    expect(decidePassportOcrRoute({ ...baseline, waiting: 1 }).provider).toBe(
      "tesseract",
    );
  });

  it("overflows at two waiting jobs or exactly twenty seconds", () => {
    expect(decidePassportOcrRoute({ ...baseline, waiting: 2 })).toEqual({
      provider: "textract",
      routingReason: "LOCAL_QUEUE_DEPTH",
    });
    expect(
      decidePassportOcrRoute({ ...baseline, oldestAgeMs: 20_000 }),
    ).toEqual({
      provider: "textract",
      routingReason: "LOCAL_QUEUE_AGE",
    });
  });

  it("overflows when the worker heartbeat is unhealthy", () => {
    expect(
      decidePassportOcrRoute({ ...baseline, workerHealthy: false }),
    ).toEqual({
      provider: "textract",
      routingReason: "LOCAL_WORKER_UNHEALTHY",
    });
  });

  it("honors explicit local and Textract modes", () => {
    expect(
      decidePassportOcrRoute({ ...baseline, mode: "local", waiting: 99 }),
    ).toEqual({ provider: "tesseract", routingReason: "LOCAL_MODE" });
    expect(decidePassportOcrRoute({ ...baseline, mode: "textract" })).toEqual({
      provider: "textract",
      routingReason: "TEXTRACT_MODE",
    });
  });
});
