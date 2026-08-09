import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { redactUrl } from './redact.js';
import type { MetricsService } from '../observability/metrics.service.js';

/**
 * Logs every completed request with method, path, status, duration and a
 * masked actor id. When LOG_FORMAT=json the log line is a single JSON object
 * (key-value pairs suitable for structured ingestion); otherwise it emits the
 * human-readable line. Failures are logged by ApiExceptionFilter (with
 * internal detail); this interceptor logs the request lifecycle.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpRequest');
  constructor(private readonly metrics?: MetricsService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ method: string; url: string; correlationId?: string; user?: { id: string; accountType?: string } }>();
    const res = context.switchToHttp().getResponse<{ statusCode?: number }>();
    const start = process.hrtime.bigint();
    return next.handle().pipe(
      map((data) => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const status = res.statusCode ?? 200;
        const actor = req.user ? `${req.user.accountType ?? 'user'}:${mask(req.user.id)}` : 'anonymous';
        const fields = {
          method: req.method,
          path: redactUrl(req.url),
          status,
          durationMs: Number(durationMs.toFixed(1)),
          correlationId: req.correlationId ?? 'unknown',
          actor,
        };
        if (process.env.LOG_FORMAT === 'json') {
          this.logger.log(JSON.stringify({ event: 'http_request', ...fields }));
        } else {
          this.logger.log(`${fields.method} ${fields.path} ${fields.status} ${fields.durationMs}ms correlationId=${fields.correlationId} actor=${fields.actor}`);
        }
        this.metrics?.recordRequest(fields.method, fields.path, status, durationMs);
        return data;
      }),
    );
  }
}

function mask(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
