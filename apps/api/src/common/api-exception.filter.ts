import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { ZodError } from "zod";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<{ correlationId?: string }>();
    const res = ctx.getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const validation =
      exception instanceof ZodError
        ? exception.issues.map((issue) => ({
            field: issue.path.join(".") || "request",
            message: issue.message,
          }))
        : null;
    const status = validation
      ? HttpStatus.BAD_REQUEST
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw =
      exception instanceof HttpException ? exception.getResponse() : null;
    const httpMessage =
      typeof raw === "string"
        ? raw
        : (raw as { message?: string | string[] } | null)?.message;
    const message = validation
      ? validation.map((issue) => `${issue.field}: ${issue.message}`).join("; ")
      : (httpMessage ?? "Unexpected server error");
    const explicit =
      typeof raw === "object" && raw && "code" in raw
        ? String((raw as { code: string }).code)
        : undefined;
    res
      .status(status)
      .json({
        data: null,
        error: {
          code: validation
            ? "VALIDATION_ERROR"
            : (explicit ?? `HTTP_${status}`),
          message,
          ...(validation ? { details: validation } : {}),
        },
        meta: {
          correlationId: req.correlationId ?? "unknown",
          timestamp: new Date().toISOString(),
        },
      });
  }
}
