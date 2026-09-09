"use client";
import { useId, type MouseEvent, type ReactNode } from "react";
import { ArrowUpRight, Check } from "lucide-react";

const keepSelection = (event: MouseEvent<HTMLAnchorElement>) =>
  event.stopPropagation();

export function CheckoutConfirmation({
  checked,
  onChange,
  title,
  description,
  help,
  compact = false,
  disabled = false,
  invalid = false,
  errorId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  help?: ReactNode;
  compact?: boolean;
  disabled?: boolean;
  invalid?: boolean | undefined;
  errorId?: string | undefined;
}) {
  const descriptionId = useId();
  return (
    <div
      className={`confirmation-choice${checked ? " selected" : ""}${compact ? " compact" : ""}${invalid ? " invalid" : ""}`}
    >
      <label className="confirmation-choice-main">
        <input
          className="confirmation-choice-input"
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={
            errorId ? `${descriptionId} ${errorId}` : descriptionId
          }
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="confirmation-choice-check" aria-hidden="true">
          <Check size={15} strokeWidth={3} />
        </span>
        <span className="confirmation-choice-copy">
          <b>{title}</b>
          <small id={descriptionId}>{description}</small>
        </span>
      </label>
      {help ? <div className="confirmation-choice-help">{help}</div> : null}
    </div>
  );
}

export function CompatibilityConfirmation({
  checked,
  onChange,
  invalid,
  errorId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  invalid?: boolean;
  errorId?: string | undefined;
}) {
  return (
    <CheckoutConfirmation
      checked={checked}
      onChange={onChange}
      invalid={invalid}
      errorId={errorId}
      title="I confirm my device is eSIM compatible"
      description="I understand incompatible or carrier-locked devices are not eligible for a refund."
      help={
        <span>
          Not sure if your phone supports eSIM?{" "}
          <a
            href="/compatibility"
            target="_blank"
            rel="noopener noreferrer"
            onClick={keepSelection}
          >
            Check device compatibility
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </span>
      }
    />
  );
}

export function PurchaseConsent({
  checked,
  onChange,
  recharge = false,
  compact = false,
  invalid,
  errorId,
}: {
  checked: boolean;
  onChange: (accepted: boolean) => void;
  recharge?: boolean;
  compact?: boolean;
  invalid?: boolean;
  errorId?: string | undefined;
}) {
  return (
    <CheckoutConfirmation
      checked={checked}
      onChange={onChange}
      compact={compact}
      invalid={invalid}
      errorId={errorId}
      title={
        recharge
          ? "I approve this eSIM recharge"
          : "I agree to the purchase terms"
      }
      description={
        <>
          I have read the{" "}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            onClick={keepSelection}
          >
            Terms
          </a>
          ,{" "}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            onClick={keepSelection}
          >
            Privacy Policy
          </a>{" "}
          and{" "}
          <a
            href="/refund-policy"
            target="_blank"
            rel="noopener noreferrer"
            onClick={keepSelection}
          >
            Refund Policy
          </a>
          .
        </>
      }
    />
  );
}
