import { describe, expect, it } from "vitest";
import {
  kathmanduInputToUtc,
  utcToKathmanduInput,
} from "./homepage-campaigns-client";

describe("homepage campaign Nepal scheduling", () => {
  it("stores Asia/Kathmandu local inputs as UTC", () => {
    expect(kathmanduInputToUtc("2026-09-01T09:30")).toBe(
      "2026-09-01T03:45:00.000Z",
    );
  });

  it("round-trips UTC schedules into Nepal-local date controls", () => {
    expect(utcToKathmanduInput("2026-09-01T03:45:00.000Z")).toBe(
      "2026-09-01T09:30",
    );
    expect(utcToKathmanduInput(null)).toBe("");
  });
});
