import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PartnerCredentialStatus, PartnerStatus } from "@prisma/client";
import { createHash, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma.service.js";

export const PARTNER_SCOPES = "partner-scopes";
export const PartnerScopes = (...scopes: string[]) =>
  SetMetadata(PARTNER_SCOPES, scopes);

export type PartnerPrincipal = {
  id: string;
  code: string;
  credentialId: string;
  scopes: string[];
  status: PartnerStatus;
};
export type PartnerRequest = {
  headers: Record<string, string | undefined>;
  partner?: PartnerPrincipal;
  correlationId?: string;
};

const PARTNER_UNAUTHORIZED = (message: string) =>
  new HttpException({ code: "PARTNER_UNAUTHORIZED", message }, 401);

@Injectable()
export class PartnerAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (!this.prisma.enabled)
      throw PARTNER_UNAUTHORIZED(
        "Authentication is temporarily unavailable. Please try again shortly.",
      );
    const request = context.switchToHttp().getRequest<PartnerRequest>();
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>();
    const token = this.bearer(request.headers.authorization);
    const [keyPrefix, secret] = token.split(".");
    if (
      !keyPrefix ||
      !secret ||
      !/^vc_partner_[A-Za-z0-9_-]{8,32}$/.test(keyPrefix)
    )
      throw PARTNER_UNAUTHORIZED("Your API key is invalid.");
    const credential = await this.prisma.partnerCredential.findUnique({
      where: { keyPrefix },
      include: { partner: true },
    });
    if (
      !credential ||
      credential.status !== PartnerCredentialStatus.ACTIVE ||
      (credential.partner.status !== PartnerStatus.ACTIVE &&
        credential.partner.status !== PartnerStatus.SUSPENDED) ||
      (credential.expiresAt && credential.expiresAt <= new Date())
    )
      throw PARTNER_UNAUTHORIZED("Your API key is invalid or has expired.");
    const supplied = Buffer.from(
      createHash("sha256").update(secret).digest("hex"),
    );
    const expected = Buffer.from(credential.secretHash);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw PARTNER_UNAUTHORIZED("Your API key is invalid.");
    const scopes = Array.isArray(credential.scopes)
      ? credential.scopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [];
    const required =
      this.reflector.getAllAndOverride<string[]>(PARTNER_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.some((scope) => !scopes.includes(scope)))
      throw new HttpException(
        {
          code: "PARTNER_SCOPE_FORBIDDEN",
          message:
            "Your API key is not allowed to use this endpoint. Contact support to request access.",
        },
        403,
      );
    if (
      credential.partner.status === PartnerStatus.SUSPENDED &&
      requestMethod(request) !== "GET"
    )
      throw new HttpException(
        {
          code: "PARTNER_SUSPENDED",
          message:
            "Your partner account is suspended. Contact support for help.",
        },
        403,
      );
    const remaining = await this.consumeRateLimit(
      credential.partnerId,
      credential.partner.rateLimitPerMinute,
      response,
    );
    response.setHeader(
      "x-ratelimit-limit",
      String(credential.partner.rateLimitPerMinute),
    );
    response.setHeader("x-ratelimit-remaining", String(remaining));
    request.partner = {
      id: credential.partnerId,
      code: credential.partner.code,
      credentialId: credential.id,
      scopes,
      status: credential.partner.status,
    };
    // Credential usage is captured by structured access logs; avoid a write
    // amplification point on every authenticated API request.
    return true;
  }

  private bearer(value?: string) {
    if (!value?.startsWith("Bearer "))
      throw PARTNER_UNAUTHORIZED("Your API key is invalid.");
    return value.slice(7).trim();
  }

  private async consumeRateLimit(
    partnerId: string,
    limit: number,
    response: { setHeader(name: string, value: string): void },
  ) {
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const bucket = await this.prisma.partnerRateBucket.upsert({
      where: { partnerId_windowStart: { partnerId, windowStart } },
      update: { count: { increment: 1 } },
      create: { partnerId, windowStart, count: 1 },
    });
    if (bucket.count > limit) {
      response.setHeader(
        "Retry-After",
        String(
          Math.max(
            1,
            Math.ceil(
              (new Date(windowStart.getTime() + 60_000).getTime() -
                now.getTime()) /
                1000,
            ),
          ),
        ),
      );
      throw new HttpException(
        {
          code: "PARTNER_RATE_LIMITED",
          message: "Too many requests. Please wait and try again.",
        },
        429,
      );
    }
    return Math.max(0, limit - bucket.count);
  }
}

function requestMethod(request: PartnerRequest & { method?: string }) {
  return request.method?.toUpperCase() ?? "GET";
}
