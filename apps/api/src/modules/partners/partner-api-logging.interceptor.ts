import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { catchError, tap, throwError } from "rxjs";
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
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context
      .switchToHttp()
      .getRequest<
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
}
