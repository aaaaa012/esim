import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';

/**
 * Logs every completed request with method, path, status, duration and a
 * masked actor id. Failures are logged by ApiExceptionFilter (with internal
 * detail); this interceptor logs the request lifecycle for observability.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpRequest');
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method: string; url: string; correlationId?: string; user?: { id: string; accountType?: string } }>();
    const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const start = process.hrtime.bigint();
    return next.handle().pipe(
      map((data) => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const status = res.statusCode ?? 200;
        const actor = req.user ? `${req.user.accountType ?? 'user'}:${mask(req.user.id)}` : 'anonymous';
        this.logger.log(`${req.method} ${req.url} ${status} ${durationMs.toFixed(1)}ms correlationId=${req.correlationId ?? 'unknown'} actor=${actor}`);
        return data;
      }),
    );
  }
}

function mask(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
