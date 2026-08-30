/**
 * Client IP resolution used by rate limiters and consent logging.
 *
 * The client IP must never be taken directly from `X-Forwarded-For` or any
 * other request header, because those are trivially spoofed by a caller. The
 * only way a forwarded header is honored is when the Express `trust proxy`
 * setting is enabled and the header was appended by a proxy you control.
 *
 * `req.ip` already resolves through the `trust proxy` setting: without trust
 * proxy it is the socket peer address (non-spoofable); with trust proxy it is
 * the leftmost address supplied by a trusted proxy hop. We intentionally read
 * no forwarded headers ourselves here.
 */
export function clientIp(request: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  return request.ip || request.socket?.remoteAddress || "unknown";
}
