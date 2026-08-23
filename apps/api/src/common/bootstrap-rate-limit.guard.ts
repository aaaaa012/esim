import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { clientIp } from "./client-ip.js";
import { QueueService } from "../jobs/queue.service.js";

type Bucket = { attempts: number; resetAt: number };

/**
 * Aggressive in-memory rate limiter for the Super Admin bootstrap endpoint.
 *
 * Bootstrap grants the most sensitive privilege in the system, so attempts are
 * throttled per (IP, authenticated user) to make brute-forcing the bootstrap
 * token impractical even though the token is compared in constant time.
 *
 * NOTE: in-memory state is per process. For multi-instance deployments swap
 * this for a Redis-backed limiter.
 */
@Injectable()
export class BootstrapRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perUserLimit = Number(
    process.env.BOOTSTRAP_LIMIT_PER_MINUTE ?? 5,
  );
  private readonly perIpLimit = Number(
    process.env.BOOTSTRAP_IP_LIMIT_PER_MINUTE ?? 20,
  );
  private readonly windowMs = 60_000;

  constructor(private readonly queues?: QueueService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{
        ip?: string;
        socket?: { remoteAddress?: string };
        user?: { localUserId?: string };
      }>();
    const ip = clientIp(request);
    const userId = request.user?.localUserId ?? ip;
    const now = Date.now();
    this.prune(now);

    if (this.queues?.enabled) {
      try {
        const [userBucket, ipBucket] = await Promise.all([
          this.queues.consumeRateLimit(`bootstrap:user:${userId}`, this.windowMs),
          this.queues.consumeRateLimit(`bootstrap:ip:${ip}`, this.windowMs),
        ]);
        if (
          userBucket.count <= this.perUserLimit &&
          ipBucket.count <= this.perIpLimit
        )
          return true;
        const response = context
          .switchToHttp()
          .getResponse<{ setHeader(name: string, value: string | number): void }>();
        response.setHeader(
          "retry-after",
          Math.max(userBucket.retryAfterSeconds, ipBucket.retryAfterSeconds),
        );
        throw this.rejected();
      } catch (error) {
        if (error instanceof HttpException) throw error;
      }
    }

    const consume = (key: string, capacity: number): boolean => {
      let bucket = this.buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        bucket = { attempts: 0, resetAt: now + this.windowMs };
        this.buckets.set(key, bucket);
      }
      if (bucket.attempts >= capacity) return false;
      bucket.attempts += 1;
      return true;
    };

    const allowed =
      consume(`user:${userId}`, this.perUserLimit) &&
      consume(`ip:${ip}`, this.perIpLimit);
    if (!allowed) {
      const response = context
        .switchToHttp()
        .getResponse<{
          setHeader(name: string, value: string | number): void;
        }>();
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
            "Too many bootstrap attempts. Please wait a minute and try again.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private prune(now: number) {
    if (this.buckets.size < 20_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
