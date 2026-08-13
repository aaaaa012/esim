import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { clientIp } from './client-ip.js';

/** Tight per-IP limit for unauthenticated CPU-intensive passport OCR. */
@Injectable()
export class PassportVerificationRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit = Number(process.env.PASSPORT_OCR_RATE_LIMIT_PER_MINUTE ?? 5);

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const key = clientIp(request);
    const now = Date.now();
    const bucket = this.hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    bucket.count += 1;
    if (bucket.count <= this.limit) return true;
    throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many passport verification attempts. Please wait a minute and try again.' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
