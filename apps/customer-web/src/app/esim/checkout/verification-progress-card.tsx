"use client";
import { useEffect, useState } from "react";
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
          <b>Your next step</b>
        </span>
      </div>
      <div className="verification-progress-track" aria-hidden="true">
        <span />
      </div>
      {!compact && (
        <p className="verification-detail">
          Reading the passport information securely and preparing the traveller
          details form.
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
  const [pageVisible, setPageVisible] = useState(true);
  const [elapsedBand, setElapsedBand] = useState<
    "initial" | "delayed" | "extended"
  >("initial");

  useEffect(() => {
    const delayed = window.setTimeout(() => setElapsedBand("delayed"), 10_000);
    const extended = window.setTimeout(
      () => setElapsedBand("extended"),
      60_000,
    );
    return () => {
      window.clearTimeout(delayed);
      window.clearTimeout(extended);
    };
  }, []);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  const statusCopy =
    elapsedBand === "initial"
      ? "Your files are saved. You can safely leave while we read the passport."
      : elapsedBand === "delayed"
        ? "This is taking a little longer than usual. Your documents are safe and the check is still running."
        : "You do not need to keep this page open. We will email you and update your order when the check finishes.";

  return (
    <div className={pageVisible ? "" : "verification-animation-paused"}>
      <div
        className="passport-check checking verification-inline verification-processing-card"
        role="status"
        aria-live="polite"
      >
        <div className="verification-processing-copy">
          <b>We’re checking your passport</b>
          <small>{statusCopy}</small>
        </div>
        <VerificationJourney />
        {message ? (
          <small className="verification-refresh-note">{message}</small>
        ) : null}
        <span className="sr-only">
          Documents securely saved. Passport check in progress. We will update
          this order automatically.
        </span>
      </div>
    </div>
  );
}
