import { describe, expect, it } from "vitest";
import {
  kathmanduInputToUtc,
  resolveCampaignArtwork,
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

  it("resolves private marketing media through the API origin", () => {
    expect(
      resolveCampaignArtwork(
        "/api/v1/public/marketing-assets/campaign_example.jpg",
      ),
    ).toBe(
      "http://localhost:4000/api/v1/public/marketing-assets/campaign_example.jpg",
    );
  });
});
