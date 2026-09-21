"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Check, FileSearch2, LockKeyhole } from "lucide-react";

function VerificationJourney({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`verification-journey${compact ? " compact" : ""}`}>
      <div className="verification-scan" aria-hidden="true">
        <FileSearch2 size={compact ? 26 : 34} />
        <span />
      </div>
      <div className="verification-milestones" aria-hidden="true">
        <span className="complete">
          <i>
            <Check size={14} />
          </i>
          <b>Documents securely saved</b>
        </span>
        <span className="active">
          <i />
          <b>
            {compact ? "Verification in progress" : "Checking your passport"}
          </b>
        </span>
        <span>
          <i>
            <LockKeyhole size={13} />
          </i>
          <b>Ready for payment</b>
        </span>
      </div>
      <div className="verification-progress-track" aria-hidden="true">
        <span />
      </div>
      {!compact && (
        <p className="verification-detail">
          Checking passport details and comparing them with your traveller
          information.
        </p>
      )}
    </div>
  );
}

export default function VerificationProgressCard({
  message,
}: {
  message?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element || !expanded) return;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    return () => {
      if (element.close) element.close();
    };
  }, [expanded]);

  return (
    <div className={pageVisible ? "" : "verification-animation-paused"}>
      <div
        className="passport-check checking verification-inline"
        role="status"
      >
        <VerificationJourney compact />
        <span className="sr-only">
          Documents securely saved. Checking your passport. Payment becomes
          available when verification succeeds.
        </span>
        {message && (
          <small className="verification-refresh-note">{message}</small>
        )}
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
          aria-describedby={`${title}-description`}
          onCancel={(event) => {
            event.preventDefault();
            setExpanded(false);
          }}
        >
          <div className="verify-modal checking verification-modal-card">
            <b id={title}>Your verification is still in progress</b>
            <p id={`${title}-description`}>
              Your files are securely saved. This page updates automatically
              when verification finishes.
            </p>
            <VerificationJourney />
            {message && (
              <p className="verification-refresh-note" role="status">
                {message}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button secondary"
                autoFocus
                onClick={() => setExpanded(false)}
              >
                Close
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}
