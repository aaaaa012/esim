"use client";

import { ChevronLeft, ChevronRight, LoaderCircle, QrCode } from "lucide-react";
import { useState } from "react";
import {
  FonepayBankPicker,
  type FonepayBank,
} from "./fonepay-bank-picker";
import type { FonepayTelemetryPayload } from "./fonepay-telemetry";

export function FonepayCheckout({
  titleId,
  banks,
  qrPayload,
  qrDataUrl,
  socketReady,
  onError,
  onTelemetry,
  hint,
  busy,
  disabled,
  checkLabel,
  onCheck,
}: {
  titleId: string;
  banks?: FonepayBank[] | undefined;
  qrPayload?: string | undefined;
  qrDataUrl: string;
  socketReady: boolean;
  onError: (message: string) => void;
  onTelemetry: (event: FonepayTelemetryPayload) => void;
  hint: string;
  busy: boolean;
  disabled?: boolean;
  checkLabel: string;
  onCheck: () => void;
}) {
  const [showQr, setShowQr] = useState(false);
  const hasBanks = Boolean(banks?.length);
  const qrView = !hasBanks || showQr;

  return (
    <section className="fonepay-checkout" aria-labelledby={titleId}>
      <img
        className="fonepay-checkout-logo"
        src="/brand/fonepay-logo.png"
        alt="Checkout by Fonepay"
      />
      {qrView ? (
        <div className="fonepay-qr-stage">
          {hasBanks ? (
            <button
              type="button"
              className="fonepay-qr-back"
              onClick={() => setShowQr(false)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              Back to banking apps
            </button>
          ) : null}
          <h2 id={titleId} className="fonepay-checkout-title">
            Scan to pay with any banking app
          </h2>
          <ol className="fonepay-qr-steps">
            <li>
              Open a Fonepay-supported banking app on your phone.
            </li>
            <li>
              Choose &ldquo;Scan QR&rdquo; inside the app and scan this code.
            </li>
            <li>Approve the payment to confirm your order.</li>
          </ol>
          <img
            className="fonepay-qr"
            src={qrDataUrl}
            alt="Fonepay payment QR code"
          />
        </div>
      ) : (
        <>
          <h2 id={titleId} className="fonepay-checkout-title">
            Pay with your banking app
          </h2>
          {hasBanks ? (
            <button
              type="button"
              className="fonepay-qr-prompt"
              onClick={() => setShowQr(true)}
            >
              <QrCode size={18} aria-hidden="true" />
              <span>Scan the QR code with any banking app</span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ) : null}
          {hasBanks ? (
            <FonepayBankPicker
              banks={banks ?? []}
              qrPayload={qrPayload}
              socketReady={socketReady}
              onError={onError}
              onTelemetry={(event) => onTelemetry(event)}
            />
          ) : null}
          {hint ? (
            <p className="fonepay-bank-hint" role="status">
              {hint}
            </p>
          ) : null}
        </>
      )}
      <button
        type="button"
        className="button wide"
        disabled={busy || disabled}
        onClick={onCheck}
      >
        {busy ? (
          <>
            <LoaderCircle className="spin" size={18} />
            {checkLabel}
          </>
        ) : (
          <>
            {checkLabel}
            <ChevronRight size={18} />
          </>
        )}
      </button>
      <small className="fonepay-security-note">
        Your order is completed only after Fonepay confirms the payment.
      </small>
    </section>
  );
}