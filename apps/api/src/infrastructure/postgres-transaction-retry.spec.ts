import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { withPostgresTransactionRetry } from "./postgres-transaction-retry.js";

describe("withPostgresTransactionRetry", () => {
  it("retries PostgreSQL serialization conflicts", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("write conflict", {
          code: "P2034",
          clientVersion: "test",
        }),
      )
      .mockResolvedValue("done");

    await expect(
      withPostgresTransactionRetry(operation, { baseDelayMs: 0 }),
    ).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry business errors", async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("invalid"));
    await expect(withPostgresTransactionRetry(operation)).rejects.toThrow(
      "invalid",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
