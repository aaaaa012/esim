const SAFE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const BLOCKED_SCHEMES = new Set(["data", "file", "http", "https", "javascript"]);

export function fonepayBankIntentUrl(
  intentScheme: string,
  qrPayload: string,
): string | null {
  const raw = intentScheme.trim();
  const scheme = (raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : raw)
    .toLowerCase();
  if (!SAFE_SCHEME.test(scheme) || BLOCKED_SCHEMES.has(scheme)) return null;
  return `${scheme}://payment/?qrPayload=${encodeURIComponent(qrPayload)}`;
}
