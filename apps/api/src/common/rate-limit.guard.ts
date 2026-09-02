import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { clientIp } from "./client-ip.js";
import { QueueService } from "../jobs/queue.service.js";
import { RedisRateLimitIncidentService } from "./redis-rate-limit-incident.service.js";

type Bucket = { tokens: number; lastRefill: number };

/**
 * In-memory token-bucket limiter keyed by IP + normalized route.
 *
 * Webhook endpoints are exempt (they are signature-verified provider
 * callbacks). Public and auth routes are throttled more aggressively to slow
 * scraping and brute force; everything else gets a generous default.
 *
 * NOTE: in-memory state is per process. For multi-instance deployments swap
 * this for a Redis-backed limiter.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300);
  private readonly authLimit = Number(
    process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 60,
  );
  private readonly windowMs = 60_000;
  private redisCircuitOpenUntil = 0;
  private readonly redisCircuitMs = 5_000;

  constructor(
    private readonly queues?: QueueService,
    private readonly redisIncident?: RedisRateLimitIncidentService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{
        ip?: string;
        socket?: { remoteAddress?: string };
        path: string;
        method: string;
      }>();
    const ip = clientIp(request);
    const path = request.path ?? "";

    if (
      path.startsWith("/api/v1/webhooks/") ||
      path.startsWith("/api/v1/health/") ||
      path === "/api/v1/metrics"
    )
      return true;

    const sensitive =
      path.startsWith("/api/v1/auth") ||
      path.startsWith("/api/v1/public") ||
      path.startsWith("/api/v1/staff-activation");
    const configuredCapacity = sensitive ? this.authLimit : this.limit;
    // UUIDs and numeric ids must not form attacker-controlled fresh buckets.
    const route = path
      .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, ":id")
      // Hosted-checkout tokens are high entropy, but must still share one
      // per-IP bucket so a leaked link cannot be used to bypass throttling by
      // varying token-shaped path segments.
      .replace(/\/partner-checkout\/[A-Za-z0-9_-]{32,100}(?=\/|$)/g, "/partner-checkout/:token")
      .replace(/\/\d+(?=\/|$)/g, "/:id");
    const key = `${ip}:${request.method}:${route}`;

    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.lastRefill >= this.windowMs) {
      bucket = { tokens: configuredCapacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens +=
      ((now - bucket.lastRefill) / this.windowMs) * configuredCapacity;
    bucket.lastRefill = now;
    if (bucket.tokens > configuredCapacity) bucket.tokens = configuredCapacity;

    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string | number): void }>();
    if (this.queues?.enabled && now >= this.redisCircuitOpenUntil) {
      try {
        const shared = await this.queues.consumeRateLimit(key, this.windowMs);
        void this.redisIncident?.recovered();
        response.setHeader("x-ratelimit-limit", configuredCapacity);
        response.setHeader(
          "x-ratelimit-remaining",
          Math.max(0, configuredCapacity - shared.count),
        );
        if (shared.count > configuredCapacity) {
          response.setHeader("retry-after", shared.retryAfterSeconds);
          throw new HttpException(
            {
              code: "RATE_LIMITED",
              message: "Too many requests. Please wait a moment and try again.",
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return true;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.redisCircuitOpenUntil = now + this.redisCircuitMs;
        void this.redisIncident?.degraded(error);
      }
    }

    // Redis degradation must never hang checkout. Fall back to a deliberately
    // stricter per-process allowance until the short circuit closes.
    const capacity = this.queues?.enabled
      ? Math.max(10, Math.floor(configuredCapacity / 2))
      : configuredCapacity;
    if (bucket.tokens > capacity) bucket.tokens = capacity;
    response.setHeader("x-ratelimit-limit", capacity);
    response.setHeader("x-ratelimit-remaining", Math.floor(bucket.tokens));

    if (bucket.tokens < 1) {
      response.setHeader(
        "retry-after",
        Math.ceil((this.windowMs - (now - bucket.lastRefill)) / 1000),
      );
      throw new HttpException(
        {
          code: "RATE_LIMITED",
          message: "Too many requests. Please wait a moment and try again.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    bucket.tokens -= 1;

    if (this.buckets.size > 10_000) {
      const cutoff = now - this.windowMs * 2;
      for (const [oldKey, oldBucket] of this.buckets) {
        if (oldBucket.lastRefill < cutoff) this.buckets.delete(oldKey);
      }
    }
    return true;
  }
}
