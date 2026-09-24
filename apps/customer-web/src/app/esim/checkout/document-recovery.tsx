"use client";
import { AlertCircle, CheckCircle2, FileText } from "lucide-react";
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
  return (
    <fieldset className="document-recovery-fields" disabled={disabled}>
      <legend className="sr-only">Requested document replacements</legend>
      {requested.length > 0 && (
        <div className="document-recovery-notice" role="alert">
          <AlertCircle size={22} aria-hidden="true" />
          <span>
            <b>
              {requested.length === 1
                ? `${labels[requested[0] as DocumentType]} needs a new upload`
                : "Your documents need new uploads"}
            </b>
            <small>
              {requested.some((type) => replacementReasons?.[type as DocumentType])
                ? `Our review team could not approve the marked ${requested.length === 1 ? "file" : "files"}. Read the ${requested.length === 1 ? "reason" : "reasons"} below. `
                : `The marked ${requested.length === 1 ? "file needs a replacement" : "files need replacements"}. `}
              Upload only {requested.length === 1 ? "that document" : "those documents"}. Your other files remain saved.
            </small>
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
                    {type === "PASSPORT" && passportFailureCode === "PASSPORT_EXPIRED"
                      ? "This passport has expired. Upload a valid passport before continuing."
                      : type === "PASSPORT" && passportFailureCode === "PASSPORT_BIODATA_NOT_DETECTED"
                        ? "Upload the passport information page, including the photo and machine-readable lines."
                        : `Upload a clear, complete replacement ${labels[type].toLowerCase()}.`}
                  </small>
                </span>
              </div>
              {replacementReasons?.[type] && (
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
