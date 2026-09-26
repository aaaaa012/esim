import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { normalizeMsisdn } from "./msisdn.util.js";
import { clientIp } from "./client-ip.js";
import { QueueService } from "../jobs/queue.service.js";

type Bucket = { tokens: number; lastRefill: number };

/**
 * Aggressive rate limiter for login-free number lookups and traveller saves.
 *
 * These endpoints can reveal whether a number is already linked to an eSIM,
 * so it is throttled per (IP, normalized number) to slow number enumeration
 * while still tolerating legitimate retries. Keys are derived from a SHA-256
 * hash of the normalized number rather than the raw number to avoid holding
 * subscriber data in memory.
 */
@Injectable()
export class GuestLookupRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perNumberLimit = Number(
    process.env.TOPUP_LOOKUP_LIMIT_PER_MINUTE ?? 6,
  );
  private readonly perIpLimit = Number(
    process.env.TOPUP_LOOKUP_IP_LIMIT_PER_MINUTE ?? 30,
  );
  private readonly windowMs = 60_000;

  constructor(private readonly queues?: QueueService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      ip?: string;
      socket?: { remoteAddress?: string };
      body?: { mobile?: unknown; orderNumber?: unknown; email?: unknown };
    }>();
    const ip = clientIp(request);
    const mobile =
      typeof request.body?.mobile === "string"
        ? request.body.mobile
        : [request.body?.orderNumber, request.body?.email]
            .filter((value) => typeof value === "string")
            .join(":")
            .trim()
            .toLowerCase();
    const mobileHash = createHash("sha256")
      .update(normalizeMsisdn(mobile) || mobile)
      .digest("hex")
      .slice(0, 16);

    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string | number): void }>();
    const now = Date.now();
    this.prune(now);

    if (this.queues?.enabled) {
      try {
        const [ipBucket, numberBucket] = await Promise.all([
          this.queues.consumeRateLimit(`topup-lookup:ip:${ip}`, this.windowMs),
          this.queues.consumeRateLimit(
            `topup-lookup:num:${ip}:${mobileHash}`,
            this.windowMs,
          ),
        ]);
        const allowed =
          ipBucket.count <= this.perIpLimit &&
          numberBucket.count <= this.perNumberLimit;
        response.setHeader("x-ratelimit-limit", this.perNumberLimit);
        response.setHeader(
          "x-ratelimit-remaining",
          Math.max(0, this.perNumberLimit - numberBucket.count),
        );
        if (!allowed) {
          response.setHeader(
            "retry-after",
            Math.max(
              ipBucket.retryAfterSeconds,
              numberBucket.retryAfterSeconds,
            ),
          );
          throw this.rejected();
        }
        return true;
      } catch (error) {
        if (error instanceof HttpException) throw error;
      }
    }

    const consume = (key: string, capacity: number): boolean => {
      let bucket = this.buckets.get(key);
      if (!bucket || now - bucket.lastRefill >= this.windowMs) {
        bucket = { tokens: capacity, lastRefill: now };
        this.buckets.set(key, bucket);
      }
      bucket.tokens += ((now - bucket.lastRefill) / this.windowMs) * capacity;
      bucket.lastRefill = now;
      if (bucket.tokens > capacity) bucket.tokens = capacity;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    };

    const perIpAllowed = consume(`ip:${ip}`, this.perIpLimit);
    const perNumberAllowed = consume(
      `num:${ip}:${mobileHash}`,
      this.perNumberLimit,
    );
    const allowed = perIpAllowed && perNumberAllowed;

    response.setHeader("x-ratelimit-limit", this.perNumberLimit);
    response.setHeader(
      "x-ratelimit-remaining",
      allowed
        ? Math.max(
            0,
            Math.floor(
              this.buckets.get(`num:${ip}:${mobileHash}`)?.tokens ?? 0,
            ),
          )
        : 0,
    );
    if (!allowed) {
      response.setHeader("retry-after", Math.ceil(this.windowMs / 1000));
      throw this.rejected();
    }
    return true;
  }

  private rejected() {
    return new HttpException(
      {
        code: "RATE_LIMITED",
        message:
          "Too many lookup attempts. Please wait a moment and try again.",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private prune(now: number) {
    if (this.buckets.size < 20_000) return;
    const cutoff = now - this.windowMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key);
    }
  }
}
