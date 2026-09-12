import { afterEach, describe, expect, it } from "vitest";
import { requireProcessRole } from "./process-role.js";

const originalRole = process.env.PROCESS_ROLE;
const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalRole === undefined) delete process.env.PROCESS_ROLE;
  else process.env.PROCESS_ROLE = originalRole;
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
});

describe("requireProcessRole", () => {
  it("allows an unset PROCESS_ROLE (legacy deployments)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.PROCESS_ROLE;
    expect(() => requireProcessRole("api")).not.toThrow();
  });

  it("accepts a matching PROCESS_ROLE", () => {
    process.env.NODE_ENV = "production";
    process.env.PROCESS_ROLE = "api";
    expect(() => requireProcessRole("api")).not.toThrow();
  });

  it("rejects an explicit mismatched PROCESS_ROLE", () => {
    process.env.NODE_ENV = "production";
    process.env.PROCESS_ROLE = "ocr-worker";
    expect(() => requireProcessRole("api")).toThrow(
      "PROCESS_ROLE='api'",
    );
  });
});