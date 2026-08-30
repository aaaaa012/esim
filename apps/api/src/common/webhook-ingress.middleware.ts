import type { NextFunction, Request, Response } from "express";
import { clientIp } from "./client-ip.js";

type Bucket = { count: number; resetAt: number };

/** Lightweight protection that runs before JSON parsing and signature work. */
export function webhookIngressMiddleware() {
  const buckets = new Map<string, Bucket>();
  const limit = Number(process.env.WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE ?? 600);
  const maxBytes = Number(process.env.WEBHOOK_BODY_LIMIT_BYTES ?? 1024 * 1024);
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.path.startsWith("/api/v1/webhooks/")) return next();
    const declaredBytes = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
      return response.status(413).json({
        error: { code: "PAYLOAD_TOO_LARGE", message: "Webhook payload is too large" },
      });
    const now = Date.now();
    const key = clientIp({
      ...(request.ip ? { ip: request.ip } : {}),
      socket: {
        ...(request.socket.remoteAddress
          ? { remoteAddress: request.socket.remoteAddress }
          : {}),
      },
    });
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      response.setHeader("retry-after", Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
      return response.status(429).json({
        error: { code: "RATE_LIMITED", message: "Too many webhook requests" },
      });
    }
    if (buckets.size > 10_000)
      for (const [oldKey, value] of buckets)
        if (value.resetAt <= now) buckets.delete(oldKey);
    return next();
  };
}
