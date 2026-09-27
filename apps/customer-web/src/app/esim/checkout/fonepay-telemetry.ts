export type FonepayTelemetryEvent =
  | "QR_RENDERED"
  | "SOCKET_CONNECTED"
  | "SOCKET_ERROR"
  | "SOCKET_CLOSED"
  | "SOCKET_RECONNECTING"
  | "QR_VERIFIED_SIGNAL"
  | "PAYMENT_RESULT_SIGNAL"
  | "BANK_LAUNCH_ATTEMPTED"
  | "BANK_LAUNCH_BLOCKED"
  | "BANK_APP_NAVIGATION_OBSERVED";

export type FonepayTelemetryPlatform =
  | "ANDROID"
  | "IOS"
  | "DESKTOP"
  | "UNKNOWN";

export type FonepayTelemetryLaunchMethod =
  | "ANDROID_PACKAGE_INTENT"
  | "CUSTOM_SCHEME"
  | "QR_SCAN"
  | "NONE";

export type FonepayTelemetryReason =
  | "NON_MOBILE_DEVICE"
  | "SOCKET_NOT_READY"
  | "PAYLOAD_UNAVAILABLE"
  | "APP_NOT_OBSERVED"
  | "SOCKET_TRANSPORT_ERROR"
  | "SOCKET_REMOTE_CLOSE"
  | "SOCKET_LOCAL_CLOSE";

/**
 * A diagnostic event about how the customer's device handled the Fonepay QR.
 * The deep link is carried with its payment payload redacted so ops can verify
 * scheme freshness without leaking scan credentials.
 */
export type FonepayTelemetryPayload = {
  event: FonepayTelemetryEvent;
  bankCode?: string;
  bankName?: string;
  launchMethod?: FonepayTelemetryLaunchMethod;
  reason?: FonepayTelemetryReason;
  attempt?: number;
  /** The bare issuer scheme actually resolved for the selected bank (e.g. SNMANPKA). */
  scheme?: string;
  /** The constructed deep link with the qrPayload masked (payment credential). */
  launchUrl?: string;
};

export function fonepayPlatform(): FonepayTelemetryPlatform {
  if (typeof navigator === "undefined") return "UNKNOWN";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "ANDROID";
  if (/iPhone|iPad|iPod/i.test(ua)) return "IOS";
  return "DESKTOP";
}

/**
 * Fire-and-forget telemetry. The sender is intentionally injectable so each
 * checkout surface reuses its own authenticated API helper (customer bearer,
 * guest order token, or hosted checkout token) instead of this module reaching
 * for credentials itself. `keepalive` lets the request outlive the page
 * navigation that opens a banking app via deep link.
 */
export function postFonepayTelemetry(
  send: (path: string, init?: RequestInit) => Promise<unknown>,
  endpoint: string,
  reference: string | undefined,
  telemetry: FonepayTelemetryPayload,
): void {
  if (!reference) return;
  void send(endpoint, {
    method: "POST",
    body: JSON.stringify({
      reference,
      platform: fonepayPlatform(),
      ...telemetry,
    }),
    keepalive: true,
  }).catch(() => undefined);
}
