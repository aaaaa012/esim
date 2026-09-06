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
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const buttons = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!buttons?.length) return;
      const first = buttons.item(0);
      const last = buttons.item(buttons.length - 1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [error, onClose]);
  if (!error) return null;
  return (
    <div
      className="error-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
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
        <span className="error-modal-icon">
          <AlertCircle size={22} />
        </span>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={messageId}>{error}</p>
        </div>
        <div className="error-modal-actions">
          <button className="button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
