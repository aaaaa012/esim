import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PASSPORT_EXTRACTION_STATUSES } from "./orders.service.js";

describe("PassportExtraction database contract", () => {
  it("allows every extraction status written by the order workflow", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260922000100_passport_extraction_processing_status/migration.sql",
      ),
      "utf8",
    );

    for (const status of PASSPORT_EXTRACTION_STATUSES)
      expect(migration).toContain(`'${status}'`);
  });
});
