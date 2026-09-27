import { describe, expect, it } from "vitest";
import {
  canEnterTravelerFromPassport,
  passportAutomationUnavailable,
  passportFailurePresentation,
  passportRequiresManualReview,
  passportRequiresReplacement,
} from "./passport-outcome.js";

describe("passport outcome policy", () => {
  it("allows manual entry after a technical outage without treating the passport as invalid", () => {
    expect(passportAutomationUnavailable("OCR_UNAVAILABLE")).toBe(true);
    expect(passportRequiresReplacement("OCR_UNAVAILABLE")).toBe(false);
    expect(passportRequiresManualReview("OCR_UNAVAILABLE")).toBe(true);
    expect(
      canEnterTravelerFromPassport({
        documentReviewStatus: "NOT_STARTED",
        passportExtraction: {
          status: "MANUAL_ENTRY_REQUIRED",
          failureCode: "OCR_UNAVAILABLE",
        },
      }),
    ).toBe(true);
    expect(passportFailurePresentation("OCR_UNAVAILABLE").message).toMatch(
      /team will verify/i,
    );
  });

  it("routes checksum-insufficient MRZ evidence to review rather than reprocessing", () => {
    expect(passportRequiresManualReview("MRZ_REVIEW_REQUIRED")).toBe(true);
    expect(passportRequiresReplacement("MRZ_REVIEW_REQUIRED")).toBe(false);
  });

  it.each([
    "PASSPORT_EXPIRED",
    "PASSPORT_BIODATA_NOT_DETECTED",
    "MRZ_NOT_READABLE",
    "MRZ_OBSCURED",
    "DOCUMENT_NOT_PASSPORT",
  ])("requires replacement for %s", (failureCode) => {
    expect(passportRequiresReplacement(failureCode)).toBe(true);
    expect(
      canEnterTravelerFromPassport({
        documentReviewStatus: "REUPLOAD_REQUIRED",
        passportExtraction: { status: "MANUAL_ENTRY_REQUIRED", failureCode },
      }),
    ).toBe(false);
  });
});
