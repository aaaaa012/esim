import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeMsisdn } from './msisdn.util.js';
import { clientIp } from './client-ip.js';

type Bucket = { tokens: number; lastRefill: number };

/**
 * Aggressive rate limiter for the login-free top-up lookup endpoint.
 *
 * The endpoint is an oracle for whether an MSISDN has an existing subscriber,
 * so it is throttled per (IP, normalized number) to slow number enumeration
 * while still tolerating legitimate retries. Keys are derived from a SHA-256
 * hash of the normalized number rather than the raw number to avoid holding
 * subscriber data in memory.
 */
@Injectable()
export class GuestLookupRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perNumberLimit = Number(process.env.TOPUP_LOOKUP_LIMIT_PER_MINUTE ?? 6);
  private readonly perIpLimit = Number(process.env.TOPUP_LOOKUP_IP_LIMIT_PER_MINUTE ?? 30);
  private readonly windowMs = 60_000;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ ip?: string; socket?: { remoteAddress?: string }; body?: { mobile?: unknown } }>();
    const ip = clientIp(request);
    const mobile = typeof request.body?.mobile === 'string' ? request.body.mobile : '';
    const mobileHash = createHash('sha256').update(normalizeMsisdn(mobile) || mobile).digest('hex').slice(0, 16);

    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string | number): void }>();
    const now = Date.now();
    this.prune(now);

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
    const perNumberAllowed = consume(`num:${ip}:${mobileHash}`, this.perNumberLimit);
    const allowed = perIpAllowed && perNumberAllowed;

    response.setHeader('x-ratelimit-limit', this.perNumberLimit);
    response.setHeader('x-ratelimit-remaining', allowed ? Math.max(0, Math.floor((this.buckets.get(`num:${ip}:${mobileHash}`)?.tokens ?? 0))) : 0);
    if (!allowed) {
      response.setHeader('retry-after', Math.ceil(this.windowMs / 1000));
      throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many lookup attempts. Please wait a moment and try again.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private prune(now: number) {
    if (this.buckets.size < 20_000) return;
    const cutoff = now - this.windowMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) this.buckets.delete(key);
    }
  }
}
