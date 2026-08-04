import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { map, Observable } from 'rxjs';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; correlationId?: string }>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    const correlationId = request.headers['x-correlation-id'] || randomUUID();
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    return next.handle().pipe(map((data) => ({ data, meta: { correlationId, timestamp: new Date().toISOString() } })));
  }
}
