const SAFE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const BLOCKED_SCHEMES = new Set([
  "data",
  "file",
  "http",
  "https",
  "javascript",
]);
const SAFE_PACKAGE = /^[A-Za-z0-9]+([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function fonepayBankIntentUrl(
  intentScheme: string,
  qrPayload: string,
): string | null {
  const raw = intentScheme.trim();
  const deepLink = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/payment\/?$/);
  const scheme = deepLink?.[1] ?? raw;
  if (!SAFE_SCHEME.test(scheme) || BLOCKED_SCHEMES.has(scheme.toLowerCase()))
    return null;
  // Preserve the exact casing supplied by Fonepay. Android intent-filter
  // matching can be case-sensitive even though URI schemes generally are not.
  return `${scheme}://payment/?qrPayload=${encodeURIComponent(qrPayload)}`;
}

// V1.10 "Checkout Intent Flow" §8: on Android the merchant must also pin the
// issuer package so the intent resolves to the banking app, falling back to
// the Play Store listing when that app is not installed. Only meaningful on
// Android webviews/Chrome; other clients keep the plain scheme deep link.
export function fonepayBankAndroidIntentUrl(
  intentScheme: string,
  qrPayload: string,
  packageName: string,
): string | null {
  const raw = intentScheme.trim();
  const deepLink = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/payment\/?$/);
  const scheme = deepLink?.[1] ?? raw;
  const pkg = packageName.trim().replace(/\s+/g, "");
  if (!SAFE_SCHEME.test(scheme) || BLOCKED_SCHEMES.has(scheme.toLowerCase()))
    return null;
  if (!SAFE_PACKAGE.test(pkg)) return null;
  const store = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`;
  return `intent://payment/?qrPayload=${encodeURIComponent(qrPayload)}#Intent;scheme=${scheme};package=${pkg};S.browser_fallback_url=${encodeURIComponent(store)};end`;
}

export function filterFonepayBanks<
  T extends { bankName: string; bankCode: string },
>(banks: T[] | undefined, query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return banks ?? [];
  return (banks ?? []).filter(
    (bank) =>
      bank.bankName.toLocaleLowerCase().includes(normalized) ||
      bank.bankCode.toLocaleLowerCase().includes(normalized),
  );
}

export type FonepaySocketSignal = "QR_VERIFIED" | "PAYMENT_RESULT" | "IGNORE";

export function fonepaySocketSignal(raw: unknown): FonepaySocketSignal {
  try {
    const outer = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!outer || typeof outer !== "object") return "IGNORE";
    const transactionStatus = (outer as { transactionStatus?: unknown })
      .transactionStatus;
    const status =
      typeof transactionStatus === "string"
        ? JSON.parse(transactionStatus)
        : transactionStatus;
    if (!status || typeof status !== "object") return "IGNORE";
    const normalized = Object.fromEntries(
      Object.entries(status as Record<string, unknown>).map(([key, value]) => [
        key.replace(/\s+/g, "").toLowerCase(),
        value,
      ]),
    );
    if (typeof normalized.paymentsuccess === "boolean") return "PAYMENT_RESULT";
    if (normalized.qrverified === true) return "QR_VERIFIED";
    return "IGNORE";
  } catch {
    return "IGNORE";
  }
}
