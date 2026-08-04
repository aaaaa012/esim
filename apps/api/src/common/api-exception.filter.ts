import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ZodError } from "zod";
import { apiErrorMessage } from "@visa-compass/shared";
import { ApiException } from "./api-error.js";

/**
 * Global exception filter.
 *
 * Contract for clients:
 * - 4xx responses carry a stable public `code` and a customer-safe `message`.
 * - 5xx responses never leak internal detail; they return a generic message
 *   and a correlation id so support can trace the failure server-side.
 * - Internal diagnostic detail is always logged server-side with the
 *   correlation id and never serialized into the response.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HttpException");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<{ correlationId?: string; method?: string; url?: string }>();
    const res = ctx.getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const correlationId = req.correlationId ?? "unknown";

    const validation =
      exception instanceof ZodError
        ? exception.issues.map((issue) => ({
            field: issue.path.join(".") || "request",
            message: issue.message,
          }))
        : null;

    let status: number;
    let code: string;
    let message: string;
    let internalDetail: unknown;

    if (validation) {
      status = HttpStatus.BAD_REQUEST;
      code = "VALIDATION_ERROR";
      message = validation
        .map((issue) => `${issue.field}: ${issue.message}`)
        .join("; ");
    } else if (exception instanceof ApiException) {
      status = (exception.getStatus() as number) || HttpStatus.BAD_REQUEST;
      code = exception.code;
      message = exception.message;
      internalDetail = exception.internalDetail;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const raw = exception.getResponse();
      const parsed =
        typeof raw === "string"
          ? { message: raw }
          : (raw as { message?: string | string[]; code?: string } | null) ??
            {};
      code =
        typeof parsed.code === "string"
          ? parsed.code
          : `HTTP_${status}`;
      message = Array.isArray(parsed.message)
        ? parsed.message.join("; ")
        : (parsed.message ?? apiErrorMessage(code));
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) internalDetail = message;
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = "UNEXPECTED";
      message = apiErrorMessage("UNEXPECTED");
      internalDetail = exception;
    }

    // Log every failure server-side; never send internal detail to clients.
    const log = `${req.method ?? "?"} ${req.url ?? "?"} -> ${status} [${code}] correlationId=${correlationId}`;
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        log,
        internalDetail instanceof Error
          ? internalDetail.stack
          : JSON.stringify(internalDetail),
      );
    } else if (status >= HttpStatus.BAD_REQUEST) {
      this.logger.warn(log);
    } else {
      this.logger.log(log);
    }

    res.status(status).json({
      data: null,
      error: {
        code,
        message:
          status >= HttpStatus.INTERNAL_SERVER_ERROR &&
          !(exception instanceof ApiException)
            ? apiErrorMessage("UNEXPECTED")
            : message,
        ...(validation ? { details: validation } : {}),
      },
      meta: { correlationId, timestamp: new Date().toISOString() },
    });
  }
}
