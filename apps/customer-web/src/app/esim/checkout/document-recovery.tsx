"use client";
import { useState } from "react";
import { CheckCircle2, ChevronDown, FileText } from "lucide-react";
import { DocumentFileField } from "./document-file-field";
import { savedDocumentName, type SavedDocument } from "./document-progress";

type DocumentType = "PASSPORT" | "TICKET" | "VISA";

const labels: Record<DocumentType, string> = {
  PASSPORT: "Passport",
  TICKET: "Travel ticket",
  VISA: "Visa (optional)",
};

export function DocumentRecoveryFields({
  documents,
  types,
  files,
  onChange,
  disabled,
  capture = true,
}: {
  documents?: SavedDocument[] | undefined;
  types: string[];
  files: Partial<Record<DocumentType, File | undefined>>;
  onChange: (type: DocumentType, file: File | undefined) => void;
  disabled?: boolean;
  capture?: boolean;
}) {
  const [expanded, setExpanded] = useState<DocumentType[]>(["PASSPORT"]);
  return (
    <fieldset className="document-recovery-fields" disabled={disabled}>
      <legend className="sr-only">Documents to review</legend>
      {types.map((rawType) => {
        if (!["PASSPORT", "TICKET", "VISA"].includes(rawType)) return null;
        const type = rawType as DocumentType;
        const document = documents?.find((item) => item.type === type);
        const needsReplacement = document?.status === "REUPLOAD_REQUIRED";
        const isExpanded =
          type === "PASSPORT" || needsReplacement || expanded.includes(type);
        const optional = type === "VISA";
        if (isExpanded)
          return (
            <div
              className={`document-recovery-editor${needsReplacement ? " needs-attention" : ""}`}
              key={type}
            >
              <div className="document-recovery-editor-heading">
                <span>
                  <b>
                    {type === "PASSPORT" && needsReplacement
                      ? "Upload passport again"
                      : labels[type]}
                  </b>
                  <small>
                    {type === "PASSPORT" && needsReplacement
                      ? "Use a clear, complete photo of the information page."
                      : optional
                        ? "Optional document"
                        : "Replace this document if it is incorrect or unclear."}
                  </small>
                </span>
                {type !== "PASSPORT" && !needsReplacement && (
                  <button
                    type="button"
                    className="document-inline-action"
                    onClick={() =>
                      setExpanded((current) =>
                        current.filter((item) => item !== type),
                      )
                    }
                  >
                    Done
                  </button>
                )}
              </div>
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
            <button
              type="button"
              className="document-inline-action"
              aria-expanded="false"
              onClick={() => setExpanded((current) => [...current, type])}
            >
              Change <ChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </fieldset>
  );
}
