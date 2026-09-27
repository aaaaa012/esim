"use client";
import { useEffect, useRef, useState } from "react";

export function DocumentFileField({
  label,
  file,
  onChange,
  capture = true,
  savedName,
  replacementRequired = false,
}: {
  label: string;
  file: File | undefined;
  onChange: (file: File | undefined) => void;
  capture?: boolean;
  savedName?: string | undefined;
  replacementRequired?: boolean;
}) {
  const captureRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState("");
  useEffect(() => {
    if (!file?.type.startsWith("image/") || !URL.createObjectURL) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="file-field">
      {preview && (
        <img
          className="document-preview"
          src={preview}
          alt={`${label} selected for upload`}
        />
      )}
      <label className="file-input">
        <input
          className="native-document-input"
          type="file"
          aria-label={label}
          accept="application/pdf,image/jpeg,image/png"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) onChange(selected);
            event.target.value = "";
          }}
        />
        <span>
          <b>
            {file?.name ??
              savedName ??
              (replacementRequired ? "Choose a new file" : label)}
          </b>
          <small>
            {file
              ? `${Math.ceil(file.size / 1024)} KB · Ready to upload`
              : savedName
                ? label
                : replacementRequired
                  ? "The previous file could not be confirmed"
                  : "PDF, JPG or PNG · Up to 10 MB"}
          </small>
        </span>
        <em>
          {file || savedName
            ? "Replace"
            : replacementRequired
              ? "Choose replacement"
              : "Choose file"}
        </em>
      </label>
      {capture && (
        <>
          <input
            ref={captureRef}
            className="native-document-input"
            type="file"
            aria-label={`Take photo of ${label.toLowerCase()}`}
            accept="image/jpeg,image/png"
            capture="environment"
            style={{ display: "none" }}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) onChange(selected);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => captureRef.current?.click()}
          >
            Take photo
          </button>
        </>
      )}
    </div>
  );
}
