/**
 * TEMP(testing): Log redaction is DISABLED by default while integration
 * debugging is in progress so tokens, URLs and credentials stay visible in ops
 * logs. Set LOG_REDACTION=true (or "on"/"1") to re-enable scrubbing before
 * going back to production. Reverts with the git history of this file.
 */
export function logRedactionEnabled(): boolean {
  return /^(true|on|1)$/i.test(process.env.LOG_REDACTION ?? "false");
}

/**
 * Redacts personally identifiable values out of request URLs before they are
 * written to logs. Query parameters such as mobile numbers, tokens and email
 * addresses must never land in plaintext in access/error logs.
 */
const SENSITIVE_PARAM =
  /^(mobile|msisdn|phone|phone_number|email|token|key|secret|password|passport|reference|iccid|eid|id)$/i;

export function redactUrl(url: string): string {
  if (!logRedactionEnabled()) return url;
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
