import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { catchError, of, tap, throwError } from "rxjs";
import { from, switchMap } from "rxjs";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma.service.js";
import type { PartnerRequest } from "./partner-auth.guard.js";
import { logRedactionEnabled } from "../../common/redact.js";

const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "signature",
  "passport",
  "document",
  "email",
  "phone",
  "mobile",
  "qrcode",
  "qrpayload",
  "activationcode",
  "matchingid",
  "otp",
  "pin",
  "card",
  "accountnumber",
  "paymenturl",
  "recoverylink",
  "recoveryurl",
];

export function isSensitivePartnerLogKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redact(value: unknown, depth = 0): unknown {
  if (!logRedactionEnabled()) return value;
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || value === undefined || typeof value !== "object")
    return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        isSensitivePartnerLogKey(key) ? "[REDACTED]" : redact(item, depth + 1),
      ]),
  );
}

@Injectable()
export class PartnerApiLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PartnerApiLoggingInterceptor.name);
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<
      PartnerRequest & {
        method: string;
        originalUrl?: string;
        url: string;
        body?: unknown;
      }
    >();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode: number }>();
    const startedAt = Date.now();
    const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(
      request.method.toUpperCase(),
    );
    if (mutation && request.partner && this.prisma.enabled)
      return this.durableMutationAudit(request, response, next, startedAt);
    const write = (status: number, responseBody?: unknown, error?: unknown) => {
      if (!this.prisma.enabled) return;
      const errorValue = error as
        { code?: string; message?: string; response?: unknown } | undefined;
      const payload = errorValue?.response;
      const code =
        typeof payload === "object" && payload && "code" in payload
          ? String((payload as { code: unknown }).code)
          : errorValue?.code;
      void this.prisma.integrationLog
        .create({
          data: {
            operation: "partner-api",
            method: request.method,
            endpoint: request.originalUrl ?? request.url,
            status,
            durationMs: Date.now() - startedAt,
            correlationId: request.correlationId ?? null,
            requestBody: redact({
              partnerCode: request.partner?.code,
              body: request.body,
            }) as never,
            ...(responseBody === undefined
              ? {}
              : { responseBody: redact(responseBody) as never }),
            ...(code ? { errorCode: code } : {}),
            ...(errorValue?.message
              ? { errorMessage: errorValue.message.slice(0, 500) }
              : {}),
          },
        })
        .catch(() => undefined);
    };
    return next.handle().pipe(
      tap((body) => write(response.statusCode || 200, body)),
      catchError((error: unknown) => {
        const status =
          typeof error === "object" &&
          error &&
          "getStatus" in error &&
          typeof (error as { getStatus: unknown }).getStatus === "function"
            ? (error as { getStatus(): number }).getStatus()
            : 500;
        write(status, undefined, error);
        return throwError(() => error);
      }),
    );
  }

  private durableMutationAudit(
    request: PartnerRequest & {
      method: string;
      originalUrl?: string;
      url: string;
      body?: unknown;
    },
    response: { statusCode: number },
    next: CallHandler,
    startedAt: number,
  ) {
    const requestId = randomUUID();
    const route = (request.originalUrl ?? request.url).split("?")[0]!;
    const targetId = route.split("/").filter(Boolean).at(-1);
    return from(
      this.prisma.partnerApiAudit.create({
        data: {
          requestId,
          partnerId: request.partner!.id,
          credentialId: request.partner!.credentialId,
          method: request.method.toUpperCase(),
          route,
          action: `${request.method.toUpperCase()} ${route}`,
          correlationId: request.correlationId ?? null,
          targetId: targetId && targetId !== "orders" ? targetId : null,
          requestMeta: {
            contentPresent: request.body !== undefined,
            idempotencyKeyPresent: Boolean(
              request.headers["idempotency-key"] ??
              request.headers["x-idempotency-key"],
            ),
          },
        },
      }),
    ).pipe(
      switchMap(() =>
        next.handle().pipe(
          switchMap((body) =>
            from(
              this.prisma.partnerApiAudit.update({
                where: { requestId },
                data: {
                  status: "SUCCEEDED",
                  responseStatus: response.statusCode || 200,
                  completedAt: new Date(),
                  responseMeta: {
                    durationMs: Date.now() - startedAt,
                    resultPresent: body !== undefined,
                  },
                },
              }),
            ).pipe(
              catchError((error: unknown) => {
                this.logger.error(
                  `Partner audit ${requestId} remains STARTED after a successful mutation: ${error instanceof Error ? error.message : "unknown"}`,
                );
                return of(undefined);
              }),
              switchMap(() => of(body)),
            ),
          ),
          catchError((error: unknown) => {
            const status =
              typeof error === "object" &&
              error &&
              "getStatus" in error &&
              typeof (error as { getStatus: unknown }).getStatus === "function"
                ? (error as { getStatus(): number }).getStatus()
                : 500;
            const code =
              typeof error === "object" && error && "code" in error
                ? String((error as { code: unknown }).code)
                : null;
            return from(
              this.prisma.partnerApiAudit.update({
                where: { requestId },
                data: {
                  status: "FAILED",
                  responseStatus: status,
                  errorCode: code,
                  completedAt: new Date(),
                  responseMeta: { durationMs: Date.now() - startedAt },
                },
              }),
            ).pipe(
              catchError((auditError: unknown) => {
                this.logger.error(
                  `Partner audit ${requestId} remains STARTED after a failed mutation: ${auditError instanceof Error ? auditError.message : "unknown"}`,
                );
                return of(undefined);
              }),
              switchMap(() => throwError(() => error)),
            );
          }),
        ),
      ),
    );
  }
}
