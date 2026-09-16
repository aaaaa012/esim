"use client";

import { ChevronRight, Search, Smartphone, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FonepayBankLogo } from "./fonepay-bank-logo";
import {
  filterFonepayBanks,
  fonepayBankAndroidIntentUrl,
  fonepayBankIntentUrl,
} from "./payment-intent";

export type FonepayBank = {
  bankName: string;
  bankCode: string;
  bankIcon?: string;
  packageName?: string;
  intentScheme: string;
};

export function FonepayBankPicker({
  banks,
  qrPayload,
  socketReady,
  onError,
  onTelemetry,
}: {
  banks: FonepayBank[];
  qrPayload?: string | undefined;
  socketReady: boolean;
  onError: (message: string) => void;
  onTelemetry?: (event: {
    event:
      | "BANK_LAUNCH_ATTEMPTED"
      | "BANK_LAUNCH_BLOCKED"
      | "BANK_APP_NAVIGATION_OBSERVED";
    bankCode: string;
    bankName: string;
    launchMethod?: "ANDROID_PACKAGE_INTENT" | "CUSTOM_SCHEME" | "NONE";
    reason?:
      | "NON_MOBILE_DEVICE"
      | "SOCKET_NOT_READY"
      | "PAYLOAD_UNAVAILABLE"
      | "APP_NOT_OBSERVED";
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const visibleBanks = useMemo(
    () => filterFonepayBanks(banks, query),
    [banks, query],
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus();
    };
  }, [open]);

  const openBank = (bank: FonepayBank) => {
    if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      onTelemetry?.({
        event: "BANK_LAUNCH_BLOCKED",
        bankCode: bank.bankCode,
        bankName: bank.bankName,
        launchMethod: "NONE",
        reason: "NON_MOBILE_DEVICE",
      });
      setOpen(false);
      onError(
        "Banking apps can only be opened from a mobile device. Scan the QR code with your banking app instead.",
      );
      return;
    }
    // socketReady is advisory, not a gate: the banking app processes payment
    // independently of the WebSocket, which is only a real-time notification
    // channel. A missing socket means the customer gets no live status
    // push, but the payment can still complete and the reconciliation sweep
    // (plus manual "Check status") picks it up.
    const isAndroid = /Android/i.test(navigator.userAgent);
    const target = qrPayload
      ? ((isAndroid && bank.packageName
          ? fonepayBankAndroidIntentUrl(
              bank.intentScheme,
              qrPayload,
              bank.packageName,
            )
          : null) ?? fonepayBankIntentUrl(bank.intentScheme, qrPayload))
      : null;
    if (!target) {
      onTelemetry?.({
        event: "BANK_LAUNCH_BLOCKED",
        bankCode: bank.bankCode,
        bankName: bank.bankName,
        launchMethod: "NONE",
        reason: "PAYLOAD_UNAVAILABLE",
      });
      setOpen(false);
      onError(
        "This banking app could not be opened securely. Scan the QR code above instead.",
      );
      return;
    }
    const launchMethod =
      isAndroid && bank.packageName
        ? "ANDROID_PACKAGE_INTENT"
        : "CUSTOM_SCHEME";
    onTelemetry?.({
      event: "BANK_LAUNCH_ATTEMPTED",
      bankCode: bank.bankCode,
      bankName: bank.bankName,
      launchMethod,
    });
    window.location.assign(target);
    window.setTimeout(() => {
      if (document.visibilityState === "hidden") {
        onTelemetry?.({
          event: "BANK_APP_NAVIGATION_OBSERVED",
          bankCode: bank.bankCode,
          bankName: bank.bankName,
          launchMethod,
        });
      } else {
        onTelemetry?.({
          event: "BANK_LAUNCH_BLOCKED",
          bankCode: bank.bankCode,
          bankName: bank.bankName,
          launchMethod,
          reason: "APP_NOT_OBSERVED",
        });
        setOpen(false);
        onError(
          "Your selected mobile banking app or wallet isn't available right now. Choose another app or scan the QR code.",
        );
      }
    }, 900);
  };

  return (
    <div className="fonepay-bank-section">
      <div className="fonepay-bank-heading">
        <b>Prefer your banking app directly?</b>
        <small>
          On a phone, choose any supported banking app. On desktop, scan the QR
          above.
        </small>
      </div>
      <button
        ref={triggerRef}
        type="button"
        className="fonepay-bank-trigger"
        onClick={() => {
          setQuery("");
          setOpen(true);
        }}
      >
        <Smartphone size={19} aria-hidden="true" />
        <span>Choose banking app</span>
        <small>{banks.length} available</small>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              className="fonepay-bank-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) =>
                event.target === event.currentTarget && setOpen(false)
              }
            >
              <div
                ref={dialogRef}
                className="fonepay-bank-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
              >
                <div className="fonepay-bank-dialog-header">
                  <div>
                    <h2 id={titleId}>Choose banking app</h2>
                    <p id={descriptionId}>
                      Select an app installed on this phone.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="fonepay-bank-dialog-close"
                    aria-label="Close banking app list"
                    onClick={() => setOpen(false)}
                  >
                    <X size={19} />
                  </button>
                </div>
                <label className="fonepay-bank-search">
                  <Search size={18} aria-hidden="true" />
                  <span className="sr-only">Search banking apps</span>
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by bank name"
                    autoComplete="off"
                  />
                </label>
                <div className="fonepay-bank-list">
                  {visibleBanks.map((bank) => (
                    <button
                      type="button"
                      key={bank.bankCode}
                      onClick={() => openBank(bank)}
                    >
                      <span className="fonepay-bank-identity">
                        <FonepayBankLogo
                          name={bank.bankName}
                          src={bank.bankIcon}
                        />
                        <b>{bank.bankName}</b>
                      </span>
                      <span className="fonepay-bank-open">
                        Open <ChevronRight size={16} aria-hidden="true" />
                      </span>
                    </button>
                  ))}
                </div>
                {!visibleBanks.length ? (
                  <p className="fonepay-bank-empty">
                    No matching banking app. Try another name or scan the QR
                    code.
                  </p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
