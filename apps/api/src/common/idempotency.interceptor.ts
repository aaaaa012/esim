import { BadRequestException, CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { from, of, switchMap, tap, type Observable } from 'rxjs';
import { PrismaService } from '../infrastructure/prisma.service.js';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method: string; path: string; body?: unknown; headers: Record<string,string|undefined>; user?: { id: string } }>();
    if (!['POST','PATCH','PUT','DELETE'].includes(request.method) || request.path.includes('/webhooks/') || !this.prisma.enabled) return next.handle();
    const key = request.headers['x-idempotency-key'];
    if (!key) return next.handle();
    if (key.length < 8 || key.length > 200) throw new BadRequestException('Invalid idempotency key');
    const source = `idempotency:${request.method}:${request.path}:${request.user?.id ?? 'anonymous'}`;
    const requestHash = createHash('sha256').update(JSON.stringify(request.body ?? null)).digest('hex');
    return from(this.prisma.webhookEvent.findUnique({ where: { source_eventId: { source, eventId: key } } })).pipe(switchMap((existing) => {
      if (existing) { const payload = existing.payload as { requestHash?: string; response?: unknown }; if (payload.requestHash !== requestHash) throw new ConflictException('Idempotency key was already used with a different request'); return of(payload.response); }
      return next.handle().pipe(tap((response) => { void this.prisma.webhookEvent.create({ data: { source, eventId: key, signatureValid: true, processedAt: new Date(), payload: { requestHash, response } as never } }).catch(() => undefined); }));
    }));
  }
}
