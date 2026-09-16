"use client";

import { ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
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

/** Masks the payment credential so telemetry can carry the exact deep-link
 * shape without leaking the qrPayload needed to complete a payment. */
const redactLaunchUrl = (url: string): string =>
  url.replace(/qrPayload=[^&#]*/, "qrPayload=<redacted>");

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
    scheme?: string;
    launchUrl?: string;
  }) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleBanks = useMemo(
    () => filterFonepayBanks(banks, query),
    [banks, query],
  );

  const openBank = (bank: FonepayBank) => {
    if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      onTelemetry?.({
        event: "BANK_LAUNCH_BLOCKED",
        bankCode: bank.bankCode,
        bankName: bank.bankName,
        launchMethod: "NONE",
        reason: "NON_MOBILE_DEVICE",
      });
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
      onError(
        "This banking app could not be opened securely. Scan the QR code instead.",
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
      scheme: target.split(":")[0]!,
      launchUrl: redactLaunchUrl(target),
    });
    window.location.assign(target);
    window.setTimeout(() => {
      if (document.visibilityState === "hidden") {
        onTelemetry?.({
          event: "BANK_APP_NAVIGATION_OBSERVED",
          bankCode: bank.bankCode,
          bankName: bank.bankName,
          launchMethod,
          scheme: target.split(":")[0]!,
          launchUrl: redactLaunchUrl(target),
        });
      } else {
        onTelemetry?.({
          event: "BANK_LAUNCH_BLOCKED",
          bankCode: bank.bankCode,
          bankName: bank.bankName,
          launchMethod,
          reason: "APP_NOT_OBSERVED",
          scheme: target.split(":")[0]!,
          launchUrl: redactLaunchUrl(target),
        });
        onError(
          "Your selected mobile banking app or wallet isn't available right now. Choose another app or scan the QR code.",
        );
      }
    }, 900);
  };

  return (
    <div className="fonepay-bank-section">
      <div className="fonepay-bank-heading">
        <b>Choose your bank</b>
        <small>
          Opens the payment inside your bank&rsquo;s app on this phone. Approve
          it to confirm your order.
        </small>
      </div>
      <label className="fonepay-bank-search">
        <Search size={18} aria-hidden="true" />
        <span className="sr-only">Search banking apps</span>
        <input
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
              <FonepayBankLogo name={bank.bankName} src={bank.bankIcon} />
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
          No matching banking app. Clear the search or scan the QR code.
        </p>
      ) : null}
    </div>
  );
}