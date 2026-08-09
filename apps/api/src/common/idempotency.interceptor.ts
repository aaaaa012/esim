import { BadRequestException, CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { from, of, switchMap, tap, type Observable } from 'rxjs';
import { PrismaService } from '../infrastructure/prisma.service.js';

type IdempotencyRequest = {
  method: string;
  path: string;
  body?: unknown;
  headers: Record<string, string | undefined>;
  user?: { id: string };
  partner?: { id: string };
};

const PROCESSING = 'PROCESSING';
const DONE = 'DONE';
const CLAIM_TIMEOUT_MS = 15_000;

type ClaimResult =
  | { owned: true }
  | { owned: false; response: unknown; requestHash: string };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    if (
      !['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) ||
      request.path.includes('/webhooks/') ||
      !this.prisma.enabled
    ) {
      return next.handle();
    }
    const key = request.headers['x-idempotency-key'];
    if (!key) return next.handle();
    if (key.length < 8 || key.length > 200) throw new BadRequestException('Invalid idempotency key');

    const principalId = request.partner?.id ?? request.user?.id ?? 'anonymous';
    const source = `idempotency:${principalId}:${request.method}:${request.path}`;
    const requestHash = createHash('sha256').update(JSON.stringify(request.body ?? null)).digest('hex');

    // Atomically claim the key. The DB unique(source,eventId) makes this race-safe:
    // exactly one request owns the mutation; every other concurrent request waits for
    // the owner to finish and then replays its (already-verified) response.
    return from(this.claim(source, key, requestHash)).pipe(
      switchMap((claim) => {
        if (!claim.owned) {
          if (claim.requestHash !== requestHash) {
            return from(Promise.resolve()).pipe(switchMap(() => {
              throw new ConflictException('Idempotency key was already used with a different request');
            }));
          }
          return of(claim.response);
        }
        return next.handle().pipe(
          tap((response) => {
            void this.prisma.webhookEvent
              .update({
                where: { source_eventId: { source, eventId: key } },
                data: { processedAt: new Date(), payload: { requestHash, status: DONE, response } as never },
              })
              .catch(() => void 0);
          }),
        );
      }),
    );
  }

  private async claim(source: string, key: string, requestHash: string): Promise<ClaimResult> {
    try {
      await this.prisma.webhookEvent.create({
        data: {
          source,
          eventId: key,
          signatureValid: true,
          processedAt: new Date(),
          payload: { requestHash, status: PROCESSING } as never,
        },
      });
      return { owned: true };
    } catch (cause: unknown) {
      const code = (cause as { code?: string })?.code;
      if (code !== 'P2002') throw cause;
      // Lost the race: another request already claimed this key. Wait for it to finish.
      const deadline = Date.now() + CLAIM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const record = await this.prisma.webhookEvent.findUnique({
          where: { source_eventId: { source, eventId: key } },
        });
        const payload = record?.payload as { status?: string; requestHash?: string; response?: unknown } | undefined;
        if (payload && payload.status === DONE) {
          return { owned: false, response: payload.response, requestHash: payload.requestHash ?? '' };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new ConflictException('Idempotent request is still being processed; retry shortly');
    }
  }
}