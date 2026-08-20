/**
 * Redacts personally identifiable values out of request URLs before they are
 * written to logs. Query parameters such as mobile numbers, tokens and email
 * addresses must never land in plaintext in access/error logs.
 */
const SENSITIVE_PARAM =
  /^(mobile|msisdn|phone|phone_number|email|token|key|secret|password|passport|reference|iccid|eid|id)$/i;

export function redactUrl(url: string): string {
  if (!url) return url;
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;
  const path = url.slice(0, queryIndex);
  const rawQuery = url.slice(queryIndex + 1);
  if (!rawQuery) return url;
  const params = rawQuery.split("&");
  const redacted = params.map((param) => {
    const eq = param.indexOf("=");
    if (eq === -1) return param;
    const key = param.slice(0, eq);
    if (SENSITIVE_PARAM.test(key)) return `${key}=[redacted]`;
    return param;
  });
  return `${path}?${redacted.join("&")}`;
}
