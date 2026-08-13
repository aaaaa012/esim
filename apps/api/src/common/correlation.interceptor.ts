import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { map, Observable } from 'rxjs';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; correlationId?: string }>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    const supplied = request.headers['x-correlation-id'];
    const correlationId = supplied && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supplied) ? supplied : randomUUID();
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    return next.handle().pipe(map((data) => ({ data, meta: { correlationId, timestamp: new Date().toISOString() } })));
  }
}
