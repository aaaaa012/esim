"use client";
import { useEffect, useRef } from "react";
import VerificationProgressCard from "./verification-progress-card";
import {
  CheckCircle2,
  Clock3,
  FileCheck2,
  LoaderCircle,
  AlertTriangle,
  FileText,
} from "lucide-react";

export function DocumentProgress({
  status,
  message,
  busy = false,
  needsTravelerDetails = false,
  failureCode,
}: {
  status?: string | undefined;
  message?: string;
  busy?: boolean;
  needsTravelerDetails?: boolean;
  failureCode?: string | undefined;
}) {
  const previousStatus = useRef(status);
  const successTitle = useRef<HTMLElement>(null);
  const verified = ["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
    status ?? "",
  );
  const manual = status === "MANUAL_REVIEW";
  const pending = ["OCR_PENDING", "OCR_BACKGROUND"].includes(status ?? "");
  const replacementRequired = status === "REUPLOAD_REQUIRED";
  const correctionRequired = status === "CORRECTION_REQUIRED";
  const failed = [
    "FAILED",
    "PARTIAL",
    "CORRECTION_REQUIRED",
    "REUPLOAD_REQUIRED",
  ].includes(status ?? "");
  useEffect(() => {
    const becameVerified =
      verified &&
      previousStatus.current !== undefined &&
      !["VERIFIED", "MANUALLY_APPROVED", "SKIPPED"].includes(
        previousStatus.current,
      );
    previousStatus.current = status;
    if (!becameVerified) return;
    const element = successTitle.current;
    const timer = window.setTimeout(() => {
      element?.focus({ preventScroll: true });
      if (typeof element?.scrollIntoView === "function")
        element.scrollIntoView({
          behavior:
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth",
          block: "center",
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [status, verified]);
  const verifiedTitle =
    status === "SKIPPED" ? "Document check skipped" : "Documents verified";
  if (pending && !busy) return <VerificationProgressCard message={message} />;
  return (
    <div
      className={`passport-check document-progress ${busy || pending ? "checking" : verified ? "verified" : manual ? "manual" : failed ? "warning" : ""}`}
      role="status"
      aria-live={verified ? "polite" : undefined}
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
        <b ref={successTitle} tabIndex={verified ? -1 : undefined}>
          {busy
            ? message?.startsWith("Checking")
              ? "Checking your passport"
              : "Saving your documents"
            : verified
              ? verifiedTitle
              : manual
                ? needsTravelerDetails
                  ? "Documents saved — add traveller details"
                  : "Documents awaiting review"
                : pending
                  ? "Checking your passport"
                  : replacementRequired
                    ? "One or more documents need replacement"
                    : correctionRequired
                      ? "Passport and traveller details need checking"
                      : failed
                        ? "Passport verification needs attention"
                        : "Upload your travel documents"}
        </b>
        <small>
          {message ||
            (busy
              ? "Keep this page open until your files are securely saved."
              : verified
                ? "Your required documents are ready. Continue to payment when you’re ready."
                : manual
                  ? needsTravelerDetails
                    ? failureCode === "MRZ_REVIEW_REQUIRED"
                      ? "Your files are saved. We recognized the passport, but could not reliably read its code lines. Add traveller details while our team checks it; payment opens after approval."
                      : "Your files are saved. Add traveller details while our team checks the passport; payment opens after approval."
                    : "Your documents are saved and awaiting review. This page updates automatically. Payment becomes available after approval."
                  : pending
                    ? "Your documents are saved. We’re checking them against your traveller details. This page updates automatically."
                    : replacementRequired
                      ? "A saved file could not be confirmed as the required document. Replace the item marked below before continuing."
                      : correctionRequired
                        ? "We couldn’t confirm that your passport matches your traveller details. Check the details you entered before continuing."
                        : failed
                          ? "We couldn’t read or verify the passport reliably. Review the document guidance below before continuing."
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

export function hasUploadedDocument(
  documents: SavedDocument[] | undefined,
  type: string,
) {
  return (
    documents?.some(
      (document) => document.type === type && document.uploadVerified === true,
    ) ?? false
  );
}

export function savedDocumentName(
  documents: SavedDocument[] | undefined,
  type: string,
) {
  return documents?.find(
    (document) =>
      document.type === type &&
      document.uploadVerified === true &&
      document.status !== "REUPLOAD_REQUIRED",
  )?.fileName;
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

export function VerifiedDocumentsSummary({
  documents,
  reviewStatus,
}: {
  documents?: SavedDocument[] | undefined;
  reviewStatus?: string | undefined;
}) {
  const saved = (type: string) =>
    documents?.find(
      (document) => document.type === type && document.uploadVerified,
    );
  const passport = saved("PASSPORT");
  const ticket = saved("TICKET");
  const visa = saved("VISA");
  const passportLabel =
    reviewStatus === "MANUALLY_APPROVED"
      ? "Approved"
      : reviewStatus === "SKIPPED"
        ? "Accepted"
        : "Verified";
  const rows = [
    { type: "Passport", document: passport, state: passportLabel },
    { type: "Travel ticket", document: ticket, state: "Securely saved" },
    {
      type: "Visa",
      document: visa,
      state: visa ? "Added" : "Optional",
    },
  ];
  return (
    <ul className="verified-documents-summary" aria-label="Document summary">
      {rows.map(({ type, document, state }) => (
        <li key={type}>
          <span className={`verified-document-icon${document ? " saved" : ""}`}>
            {document ? <CheckCircle2 size={18} /> : <FileText size={18} />}
          </span>
          <span>
            <b>{type}</b>
            <small>
              {document?.fileName || (type === "Visa" ? "Not added" : "")}
            </small>
          </span>
          <strong>{state}</strong>
        </li>
      ))}
    </ul>
  );
}
