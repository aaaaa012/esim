"use client";
import { AlertCircle, CheckCircle2, FileText } from "lucide-react";
import { passportFailurePresentation } from "@visa-compass/shared";
import { DocumentFileField } from "./document-file-field";
import { savedDocumentName, type SavedDocument } from "./document-progress";

type DocumentType = "PASSPORT" | "TICKET" | "VISA";

const labels: Record<DocumentType, string> = {
  PASSPORT: "Passport",
  TICKET: "Travel ticket",
  VISA: "Visa (optional)",
};

export function replacementReasonsFromTimeline(
  timeline: { reason?: string | null }[] | undefined,
): Partial<Record<DocumentType, string>> {
  const reasons: Partial<Record<DocumentType, string>> = {};
  for (const event of [...(timeline ?? [])].reverse()) {
    const reason = event.reason?.trim() ?? "";
    const specific = /^(PASSPORT|TICKET):\s*(.+)$/i.exec(reason);
    if (specific) {
      const type = specific[1]!.toUpperCase() as DocumentType;
      reasons[type] ??= specific[2]!.replace(/\s+\(requested by [^)]+\)$/, "").trim();
    } else if (reason.startsWith("Documents requested again:")) {
      const comment = reason.replace(/^Documents requested again:\s*/, "").trim();
      reasons.PASSPORT ??= comment;
      reasons.TICKET ??= comment;
    }
  }
  return reasons;
}

export function DocumentRecoveryFields({
  documents,
  types,
  files,
  onChange,
  disabled,
  capture = true,
  passportFailureCode,
  replacementReasons,
}: {
  documents?: SavedDocument[] | undefined;
  types: string[];
  files: Partial<Record<DocumentType, File | undefined>>;
  onChange: (type: DocumentType, file: File | undefined) => void;
  disabled?: boolean;
  capture?: boolean;
  passportFailureCode?: string | undefined;
  replacementReasons?: Partial<Record<DocumentType, string>> | undefined;
}) {
  const requested = types.filter((type) =>
    documents?.some(
      (document) =>
        document.type === type && document.status === "REUPLOAD_REQUIRED",
    ),
  );
  const singleType = requested.length === 1 ? requested[0] as DocumentType : undefined;
  const reviewReason = singleType ? replacementReasons?.[singleType] : undefined;
  const passportReason = singleType === "PASSPORT" && passportFailureCode
    ? passportFailurePresentation(passportFailureCode)
    : undefined;
  return (
    <fieldset className="document-recovery-fields" disabled={disabled}>
      <legend className="sr-only">Requested document replacements</legend>
      {requested.length > 0 && (
        <div className="document-recovery-notice" role="alert">
          <AlertCircle size={22} aria-hidden="true" />
          <span>
            <b>
              {passportReason && !reviewReason
                ? passportReason.title
                : requested.length === 1
                  ? `${labels[requested[0] as DocumentType]} needs a new upload`
                : "Your documents need new uploads"}
            </b>
            {reviewReason ? (
              <small>Reason from our review team: <span>{reviewReason}</span></small>
            ) : passportReason ? (
              <small>{passportReason.message}</small>
            ) : (
              <small>{requested.length === 1 ? "This document needs a replacement." : "The marked files need replacements. Read the reasons below."}</small>
            )}
            <small>Upload only {requested.length === 1 ? "this document" : "the marked documents"}; your other files remain saved.</small>
          </span>
        </div>
      )}
      {types.map((rawType) => {
        if (!["PASSPORT", "TICKET", "VISA"].includes(rawType)) return null;
        const type = rawType as DocumentType;
        const document = documents?.find((item) => item.type === type);
        const needsReplacement = document?.status === "REUPLOAD_REQUIRED";
        const optional = type === "VISA";
        if (needsReplacement)
          return (
            <div
              className="document-recovery-editor needs-attention"
              key={type}
            >
              <div className="document-recovery-editor-heading">
                <span>
                  <b>Replace {labels[type].toLowerCase()}</b>
                  <small>
                    {type === "PASSPORT" && passportReason && !reviewReason
                      ? "Choose a new passport photo or file below."
                      : `Upload a clear, complete replacement ${labels[type].toLowerCase()}.`}
                  </small>
                </span>
              </div>
              {replacementReasons?.[type] && requested.length > 1 && (
                <p className="document-recovery-reason">
                  <b>Reason from our review team</b>
                  {replacementReasons[type]}
                </p>
              )}
              <DocumentFileField
                label={labels[type]}
                file={files[type]}
                savedName={savedDocumentName(documents, type)}
                replacementRequired={needsReplacement}
                onChange={(file) => onChange(type, file)}
                capture={capture}
              />
            </div>
          );
        if (!document?.uploadVerified && optional) return null;
        return (
          <div className="document-recovery-saved" key={type}>
            <span className={document?.uploadVerified ? "saved" : ""}>
              {document?.uploadVerified ? (
                <CheckCircle2 size={18} aria-hidden="true" />
              ) : (
                <FileText size={18} aria-hidden="true" />
              )}
            </span>
            <span>
              <b>{labels[type]}</b>
              <small>
                {document?.fileName || (optional ? "Not added" : "Not saved")}
              </small>
            </span>
            <span className="document-recovery-kept">Kept on file</span>
          </div>
        );
      })}
    </fieldset>
  );
}
