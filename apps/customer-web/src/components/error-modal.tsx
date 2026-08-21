"use client";

import { AlertCircle, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

export default function ErrorModal({
  error,
  title = "We couldn't complete that",
  onClose,
}: {
  error: string | null;
  title?: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!error) return;
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [error, onClose]);
  if (!error) return null;
  return (
    <div
      className="error-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="error-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <button
          ref={closeRef}
          className="error-modal-close"
          onClick={onClose}
          aria-label="Dismiss message"
        >
          <X size={18} />
        </button>
        <span className="error-modal-icon"><AlertCircle size={22} /></span>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={messageId}>{error}</p>
        </div>
      </div>
    </div>
  );
}
