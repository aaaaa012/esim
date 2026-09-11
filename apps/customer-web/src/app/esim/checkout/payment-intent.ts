const SAFE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const BLOCKED_SCHEMES = new Set(["data", "file", "http", "https", "javascript"]);

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

export function filterFonepayBanks<T extends { bankName: string; bankCode: string }>(
  banks: T[] | undefined,
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return banks ?? [];
  return (banks ?? []).filter(
    (bank) =>
      bank.bankName.toLocaleLowerCase().includes(normalized) ||
      bank.bankCode.toLocaleLowerCase().includes(normalized),
  );
}
