"use client";

import { ChevronLeft, ChevronRight, LoaderCircle, QrCode } from "lucide-react";
import { useEffect, useState } from "react";
import {
  FonepayBankPicker,
  type FonepayBank,
} from "./fonepay-bank-picker";
import type { FonepayTelemetryPayload } from "./fonepay-telemetry";

function PaymentExpiryCountdown({ expiresAt }: { expiresAt: string }) {
  const expiry = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
    const interval = window.setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= expiry) window.clearInterval(interval);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [expiry]);

  if (!Number.isFinite(expiry)) return null;
  const remainingSeconds = Math.max(0, Math.ceil((expiry - now) / 1_000));
  if (remainingSeconds === 0)
    return (
      <div className="fonepay-qr-expiry is-expired" role="status">
        <b>This QR has expired</b>
        <span>Check payment status before requesting a new QR.</span>
      </div>
    );

  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  const timer = hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  return (
    <div className="fonepay-qr-expiry">
      <span>Pay within</span>
      <b role="timer" aria-label={`${remainingSeconds} seconds remaining`}>
        {timer}
      </b>
      <small>
        Payment status is checked automatically when the timer ends.
      </small>
    </div>
  );
}

export function FonepayCheckout({
  titleId,
  banks,
  qrPayload,
  qrDataUrl,
  expiresAt,
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
  qrDataUrl?: string | undefined;
  expiresAt?: string;
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
      {expiresAt ? <PaymentExpiryCountdown expiresAt={expiresAt} /> : null}
      {qrView ? (
        <div className="fonepay-qr-view">
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
          <div className="fonepay-qr-card">
            {qrDataUrl ? (
              <img
                className="fonepay-qr"
                src={qrDataUrl}
                alt="Fonepay payment QR code"
              />
            ) : (
              <div className="fonepay-qr-fallback-box" role="status">
                <b>Scan code saved in your banking app</b>
                <span>
                  The QR image is not available yet. Open a Fonepay-supported
                  banking app, choose the saved code for this store under
                  &ldquo;Scan QR&rdquo;, and approve the payment.
                </span>
              </div>
            )}
          </div>
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
