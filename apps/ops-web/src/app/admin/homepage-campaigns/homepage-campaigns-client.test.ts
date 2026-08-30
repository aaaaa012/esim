import { describe, expect, it } from "vitest";
import {
  kathmanduInputToUtc,
  resolveCampaignArtwork,
  utcToKathmanduInput,
  validateCampaignForm,
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

  it("reports only the actual invalid field instead of blaming valid inputs", () => {
    expect(
      validateCampaignForm({
        title: "Weekend offer",
        altText: "short",
        placement: "OFFER_GALLERY",
        countryCode: "",
        ctaLabel: "Browse travel plans",
        sortOrder: "3",
        active: true,
        startsAt: "",
        endsAt: "",
      }),
    ).toEqual({
      altText: "Describe the artwork and offer in at least 12 characters.",
    });
  });

  it("rejects a Nepal-time end date that is not after the start date", () => {
    expect(
      validateCampaignForm({
        title: "Weekend offer",
        altText: "A descriptive campaign offer",
        placement: "OFFER_GALLERY",
        countryCode: "",
        ctaLabel: "Browse travel plans",
        sortOrder: "3",
        active: true,
        startsAt: "2026-09-02T09:00",
        endsAt: "2026-09-02T08:00",
      }).endsAt,
    ).toBe("End time must be later than start time.");
  });
});
