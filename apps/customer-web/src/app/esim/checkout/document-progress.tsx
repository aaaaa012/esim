"use client";
import VerificationProgressCard from "./verification-progress-card";
import {
  CheckCircle2,
  Clock3,
  FileCheck2,
  LoaderCircle,
  AlertTriangle,
} from "lucide-react";

export function DocumentProgress({
  status,
  message,
  busy = false,
}: {
  status?: string | undefined;
  message?: string;
  busy?: boolean;
}) {
  const verified = ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
    status ?? "",
  );
  const manual = status === "MANUAL_REVIEW";
  const pending = ["OCR_PENDING", "OCR_BACKGROUND"].includes(status ?? "");
  if (pending && !busy) return <VerificationProgressCard message={message} />;
  const failed = ["FAILED", "PARTIAL", "REUPLOAD_REQUIRED"].includes(
    status ?? "",
  );
  return (
    <div
      className={`passport-check document-progress ${busy || pending ? "checking" : verified ? "verified" : manual ? "manual" : failed ? "warning" : ""}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {busy || pending ? (
        <LoaderCircle className="spin" size={22} />
      ) : verified ? (
        <CheckCircle2 size={22} />
      ) : manual ? (
        <Clock3 size={22} />
      ) : failed ? (
        <AlertTriangle size={22} />
      ) : (
        <FileCheck2 size={22} />
      )}
      <span>
        <b>
          {busy
            ? message?.startsWith("Checking")
              ? "Checking your passport"
              : "Saving your documents"
            : verified
              ? "Documents verified"
              : manual
                ? "Documents awaiting review"
                : pending
                  ? "Checking your passport"
                  : failed
                    ? "Your documents need attention"
                    : "Upload your travel documents"}
        </b>
        <small>
          {message ||
            (busy
              ? "Keep this page open until your files are securely saved."
              : verified
                ? "You can now continue to payment."
                : manual
                  ? "Your documents are saved and awaiting review. This page updates automatically. Payment becomes available after approval."
                  : pending
                    ? "Your documents are saved. We’re checking them against your traveller details. This page updates automatically."
                    : failed
                      ? "Review your traveller details and the document status below. Replace any unclear or incomplete files, then check again."
                      : "PDF, JPG or PNG, up to 10 MB per file. Payment becomes available after verification.")}
        </small>
      </span>
    </div>
  );
}

export type SavedDocument = {
  type: string;
  status: string;
  fileName?: string;
  uploadVerified?: boolean;
};

export function hasSavedDocument(
  documents: SavedDocument[] | undefined,
  type: string,
) {
  return (
    documents?.some(
      (document) =>
        document.type === type &&
        document.uploadVerified === true &&
        document.status !== "REUPLOAD_REQUIRED",
    ) ?? false
  );
}

export function SavedDocuments({
  documents,
}: {
  documents?: SavedDocument[] | undefined;
}) {
  const saved = documents?.filter((document) => document.uploadVerified);
  if (!saved?.length) return null;
  return (
    <ul className="saved-documents" aria-label="Saved documents">
      {saved.map((document) => (
        <li key={document.type}>
          <strong>
            {document.type === "PASSPORT"
              ? "Passport"
              : document.type === "TICKET"
                ? "Travel ticket"
                : "Visa"}
          </strong>
          : {document.fileName || "Document"} ·{" "}
          {document.status === "REUPLOAD_REQUIRED"
            ? "Replacement requested"
            : "Securely saved"}
        </li>
      ))}
    </ul>
  );
}
