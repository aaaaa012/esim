import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { ApiIdempotencyStatus, Prisma } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  catchError,
  from,
  map,
  of,
  switchMap,
  throwError,
  type Observable,
} from "rxjs";
import { PrismaService } from "../infrastructure/prisma.service.js";

const conflict = (message: string) =>
  new HttpException({ code: "IDEMPOTENCY_CONFLICT", message }, 409);
const CLAIM_TIMEOUT_MS = 15_000;
const CLAIM_LEASE_MS = 2 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;

type Request = {
  method: string;
  path: string;
  body?: unknown;
  headers: Record<string, string | undefined>;
  user?: { id: string };
  partner?: { id: string };
};
type Claim =
  | { owned: true; id: string }
  | { owned: false; response: unknown; responseStatus: number | null };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (
      !["POST", "PATCH", "PUT", "DELETE"].includes(request.method) ||
      request.path.includes("/webhooks/") ||
      request.path.includes("/recharges") ||
      Boolean(
        request.body &&
        typeof request.body === "object" &&
        "lookupToken" in request.body,
      ) ||
      !this.prisma.enabled
    )
      return next.handle();

    const key =
      request.headers["idempotency-key"] ??
      request.headers["x-idempotency-key"];
    if (!key) {
      if (request.partner)
        throw new HttpException(
          {
            code: "IDEMPOTENCY_KEY_REQUIRED",
            message: "Idempotency-Key is required for partner mutations",
          },
          400,
        );
      return next.handle();
    }
    if (key.length < 8 || key.length > 200)
      throw new HttpException(
        { code: "INVALID_IDEMPOTENCY_KEY", message: "Invalid idempotency key" },
        400,
      );

    const principalId = request.partner?.id ?? request.user?.id ?? "anonymous";
    const method = request.method;
    const route = normalizeRoute(request.path);
    const requestHash = createHash("sha256")
      .update(canonicalJson(request.body ?? null))
      .digest("hex");
    const response = http.getResponse<{
      statusCode?: number;
      status(code: number): unknown;
      setHeader(name: string, value: string): unknown;
    }>();

    return from(this.claim(principalId, method, route, key, requestHash)).pipe(
      switchMap((claim) => {
        if (!claim.owned) {
          if (claim.responseStatus) response.status(claim.responseStatus);
          response.setHeader("Idempotency-Replayed", "true");
          return of(claim.response);
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(
              this.prisma.apiIdempotencyRecord.update({
                where: { id: claim.id },
                data: {
                  status: ApiIdempotencyStatus.COMPLETED,
                  responseStatus: response.statusCode ?? 200,
                  response: sealReplayResponse(body),
                  claimExpiresAt: new Date(),
                },
              }),
            ).pipe(map(() => body)),
          ),
          catchError((error) =>
            from(
              this.prisma.apiIdempotencyRecord.updateMany({
                where: {
                  id: claim.id,
                  status: ApiIdempotencyStatus.PROCESSING,
                },
                data: {
                  status: ApiIdempotencyStatus.FAILED,
                  claimExpiresAt: new Date(),
                },
              }),
            ).pipe(switchMap(() => throwError(() => error))),
          ),
        );
      }),
    );
  }

  private async claim(
    principalId: string,
    method: string,
    route: string,
    key: string,
    requestHash: string,
  ): Promise<Claim> {
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
    try {
      const record = await this.prisma.apiIdempotencyRecord.create({
        data: {
          principalId,
          method,
          route,
          key,
          requestHash,
          claimExpiresAt,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
      });
      return { owned: true, id: record.id };
    } catch (cause) {
      if ((cause as { code?: string }).code !== "P2002") throw cause;
    }

    const deadline = Date.now() + CLAIM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = await this.prisma.apiIdempotencyRecord.findUnique({
        where: {
          principalId_method_route_key: { principalId, method, route, key },
        },
      });
      if (!record) {
        await wait();
        continue;
      }
      if (record.requestHash !== requestHash)
        throw conflict(
          "Idempotency key was already used with a different request",
        );
      if (record.status === ApiIdempotencyStatus.COMPLETED)
        return {
          owned: false,
          response: openReplayResponse(record.response),
          responseStatus: record.responseStatus,
        };
      if (
        record.status === ApiIdempotencyStatus.FAILED ||
        record.claimExpiresAt.getTime() <= Date.now()
      ) {
        const reclaimed = await this.prisma.apiIdempotencyRecord.updateMany({
          where: {
            id: record.id,
            requestHash,
            OR: [
              { status: ApiIdempotencyStatus.FAILED },
              {
                status: ApiIdempotencyStatus.PROCESSING,
                claimExpiresAt: { lte: new Date() },
              },
            ],
          },
          data: {
            status: ApiIdempotencyStatus.PROCESSING,
            claimExpiresAt,
            expiresAt: new Date(Date.now() + RETENTION_MS),
            response: Prisma.JsonNull,
            responseStatus: null,
          },
        });
        if (reclaimed.count === 1) return { owned: true, id: record.id };
      }
      await wait();
    }
    throw conflict(
      "Idempotent request is still being processed; retry shortly",
    );
  }
}

function wait() {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

function normalizeRoute(path: string) {
  return path
    .split("?")[0]!
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, ":id");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

const SEALED_RESPONSE = "visa-compass-aes-256-gcm-v1";

function containsBearerMaterial(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => containsBearerMaterial(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => {
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      return (
        /(^token$|sessiontoken|recoverytoken|accesstoken|guesttoken|lookupToken)/i.test(
          normalized,
        ) || containsBearerMaterial(item, depth + 1)
      );
    },
  );
}

function replayEncryptionKey() {
  const secret = process.env.GUEST_ORDER_SECRET;
  return secret
    ? createHash("sha256").update(`idempotency-replay:${secret}`).digest()
    : null;
}

export function sealReplayResponse(value: unknown): Prisma.InputJsonValue {
  if (!containsBearerMaterial(value)) return toJson(value);
  const key = replayEncryptionKey();
  if (!key) return { _sealed: SEALED_RESPONSE, unavailable: true };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value ?? null), "utf8"),
    cipher.final(),
  ]);
  return {
    _sealed: SEALED_RESPONSE,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function openReplayResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const sealed = value as Record<string, unknown>;
  if (sealed._sealed !== SEALED_RESPONSE) return value;
  const key = replayEncryptionKey();
  if (!key || sealed.unavailable)
    throw conflict(
      "This protected response cannot be replayed; recover the guest order instead",
    );
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(String(sealed.iv), "base64"),
    );
    decipher.setAuthTag(Buffer.from(String(sealed.tag), "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(String(sealed.ciphertext), "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw conflict("The protected replay response could not be authenticated");
  }
}
