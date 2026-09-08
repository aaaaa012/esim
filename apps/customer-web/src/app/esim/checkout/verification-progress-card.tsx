"use client";
import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

export default function VerificationProgressCard({
  message,
}: {
  message?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element || !expanded) return;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    return () => {
      if (element.close) element.close();
    };
  }, [expanded]);
  const description =
    message ||
    "Your documents are securely saved. We’re checking your passport against your traveller details. This page updates automatically when verification finishes.";
  return (
    <>
      <div className="passport-check checking" role="status">
        <LoaderCircle className="spin" size={22} />
        <span>
          <b>Checking your passport</b>
          <small>Payment becomes available after verification succeeds.</small>
        </span>
        {!expanded && (
          <button
            type="button"
            className="button secondary"
            onClick={() => setExpanded(true)}
          >
            View verification progress
          </button>
        )}
      </div>
      {expanded && (
        <dialog
          className="verification-progress-dialog"
          ref={dialog}
          aria-labelledby={title}
          onCancel={(event) => {
            event.preventDefault();
            setExpanded(false);
          }}
        >
          <div className="verify-modal checking">
            <LoaderCircle
              className="spin verify-modal-icon"
              size={38}
              aria-hidden="true"
            />
            <b id={title}>Your verification is still in progress</b>
            <p role="status">{description}</p>
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                autoFocus
                onClick={() => setExpanded(false)}
              >
                Keep waiting
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}
