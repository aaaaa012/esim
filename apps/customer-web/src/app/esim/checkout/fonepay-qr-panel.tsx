"use client";

import { ChevronDown, QrCode } from "lucide-react";
import { useState } from "react";

export function FonepayQrPanel({
  qrDataUrl,
  defaultOpen = false,
  hideToggle = false,
}: {
  qrDataUrl: string;
  defaultOpen?: boolean;
  hideToggle?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <aside className="fonepay-qr-col">
      {!hideToggle ? (
        <button
          type="button"
          className="fonepay-qr-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <QrCode size={18} aria-hidden="true" />
          <span>Scan the QR code instead</span>
          <ChevronDown
            className="fonepay-qr-toggle-chevron"
            aria-hidden="true"
          />
        </button>
      ) : null}
      <div className="fonepay-qr-panel" hidden={!open}>
        <p className="fonepay-qr-note">
          Open any Fonepay-supported banking app on this phone and choose
          &ldquo;Scan QR&rdquo; to pay with this code.
        </p>
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
    </aside>
  );
}