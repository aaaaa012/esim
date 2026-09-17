import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AuthenticatedRequest } from "./auth.guard.js";
import { QueueService } from "../jobs/queue.service.js";
import { RedisRateLimitIncidentService } from "./redis-rate-limit-incident.service.js";
import { MetricsService } from "../observability/metrics.service.js";

type Bucket = { count: number; resetAt: number };

@Injectable()
export class AuthMeRateLimitGuard implements CanActivate {
  private readonly userLimit = Number(process.env.AUTH_ME_RATE_LIMIT_PER_MINUTE ?? 120);
  private readonly windowMs = 60_000;
  private readonly local = new Map<string, Bucket>();

  constructor(
    private readonly queues?: QueueService,
    private readonly redisIncident?: RedisRateLimitIncidentService,
    private readonly metrics?: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string | number): void }>();
    if (!request.user) throw new HttpException({ code: "AUTHENTICATION_REQUIRED", message: "Authentication required" }, HttpStatus.UNAUTHORIZED);

    const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
    const result = await this.consume(`auth-me:user:${digest(request.user.localUserId ?? request.user.id)}`);
    const remaining = Math.max(0, result.capacity - result.count);
    if (result.count > result.capacity) {
      this.metrics?.recordFailure("auth-me-rate-limit", "user");
      response.setHeader("x-ratelimit-limit", result.capacity);
      response.setHeader("x-ratelimit-remaining", 0);
      response.setHeader("retry-after", result.retryAfterSeconds);
      throw new HttpException({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment and try again." }, HttpStatus.TOO_MANY_REQUESTS);
    }
    response.setHeader("x-ratelimit-limit", result.capacity);
    response.setHeader("x-ratelimit-remaining", remaining);
    return true;
  }

  private async consume(key: string) {
    if (this.queues?.enabled) {
      try {
        const result = await this.queues.consumeRateLimit(key, this.windowMs);
        void this.redisIncident?.recovered();
        return { ...result, capacity: this.userLimit };
      } catch (error) {
        void this.redisIncident?.degraded(error);
        this.metrics?.recordFailure("auth-me-rate-limit", "redis-unavailable");
        throw new HttpException(
          { code: "SERVICE_UNAVAILABLE", message: "Session verification is temporarily unavailable." },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }
    const now = Date.now();
    const current = this.local.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + this.windowMs } : current;
    bucket.count += 1;
    this.local.set(key, bucket);
    if (this.local.size > 10_000) {
      for (const [oldKey, old] of this.local) if (old.resetAt <= now) this.local.delete(oldKey);
    }
    const capacity = this.userLimit;
    return { count: bucket.count, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), capacity };
  }
}
