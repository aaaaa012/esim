export const PASSPORT_REUPLOAD_FAILURES = new Set([
  "PASSPORT_EXPIRED",
  "PASSPORT_BIODATA_NOT_DETECTED",
  "MRZ_NOT_READABLE",
  "MRZ_OBSCURED",
  "DOCUMENT_NOT_PASSPORT",
  "DOCUMENT_REUPLOAD_REQUIRED",
]);

export const PASSPORT_TECHNICAL_FAILURES = new Set([
  "OCR_UNAVAILABLE",
  "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD",
  "QUEUE_UNAVAILABLE",
  "DOCUMENT_PROCESSING_FAILED",
  "EXTRACTION_PAYLOAD_UNAVAILABLE",
]);

export type PassportExtractionLike = {
  status?: string;
  failureCode?: string;
};

export const passportRequiresReplacement = (failureCode?: string | null) =>
  PASSPORT_REUPLOAD_FAILURES.has(failureCode ?? "");

export const passportAutomationUnavailable = (failureCode?: string | null) =>
  PASSPORT_TECHNICAL_FAILURES.has(failureCode ?? "");

export const passportRequiresManualReview = (failureCode?: string | null) =>
  passportAutomationUnavailable(failureCode) ||
  failureCode === "MRZ_REVIEW_REQUIRED";

export const canEnterTravelerFromPassport = (input: {
  documentReviewStatus?: string | null;
  passportExtraction?: PassportExtractionLike | null;
}) =>
  input.documentReviewStatus !== "REUPLOAD_REQUIRED" &&
  !passportRequiresReplacement(input.passportExtraction?.failureCode) &&
  Boolean(
    input.passportExtraction &&
      ["READY", "PARTIAL", "MANUAL_ENTRY_REQUIRED", "SKIPPED"].includes(
        input.passportExtraction.status ?? "",
      ),
  );

export const passportFailurePresentation = (failureCode?: string | null) => {
  switch (failureCode) {
    case "PASSPORT_EXPIRED":
      return {
        title: "Passport expired",
        message: "This passport has expired. Upload a valid passport before continuing.",
      };
    case "PASSPORT_BIODATA_NOT_DETECTED":
    case "DOCUMENT_NOT_PASSPORT":
      return {
        title: "Passport document not recognized",
        message: "Upload the passport biodata page that shows the holder's photo and identity details.",
      };
    case "MRZ_NOT_READABLE":
    case "MRZ_OBSCURED":
      return {
        title: "Passport details could not be read",
        message: "Upload a clear passport biodata page with the two machine-readable lines fully visible.",
      };
    case "OCR_UNAVAILABLE":
    case "OCR_UNAVAILABLE_AFTER_GRACE_PERIOD":
    case "QUEUE_UNAVAILABLE":
    case "DOCUMENT_PROCESSING_FAILED":
    case "EXTRACTION_PAYLOAD_UNAVAILABLE":
      return {
        title: "Automatic passport reading unavailable",
        message: "Your passport is securely saved, but we could not read it automatically. Enter the details exactly as shown; our team will verify them before payment.",
      };
    case "MRZ_REVIEW_REQUIRED":
      return {
        title: "Passport review required",
        message: "Your passport is securely saved, but its machine-readable details require review before payment.",
      };
    default:
      return {
        title: "Document check needs attention",
        message: "We could not complete the automatic document check. Review the requested details or wait for manual verification.",
      };
  }
};
