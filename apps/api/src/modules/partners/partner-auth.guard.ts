import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
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

@Injectable()
export class PartnerAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (!this.prisma.enabled)
      throw new UnauthorizedException("Partner persistence is required");
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
      throw new UnauthorizedException("Valid partner API key required");
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
      throw new UnauthorizedException("Valid partner API key required");
    const supplied = Buffer.from(
      createHash("sha256").update(secret).digest("hex"),
    );
    const expected = Buffer.from(credential.secretHash);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new UnauthorizedException("Valid partner API key required");
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
          message: "Partner scope is not permitted",
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
          message: "Partner is suspended; new mutations are not permitted",
        },
        403,
      );
    const remaining = await this.consumeRateLimit(
      credential.partnerId,
      credential.partner.rateLimitPerMinute,
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
    await this.prisma.partnerCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    });
    return true;
  }

  private bearer(value?: string) {
    if (!value?.startsWith("Bearer "))
      throw new UnauthorizedException("Valid partner API key required");
    return value.slice(7).trim();
  }

  private async consumeRateLimit(partnerId: string, limit: number) {
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const bucket = await this.prisma.partnerRateBucket.upsert({
      where: { partnerId_windowStart: { partnerId, windowStart } },
      update: { count: { increment: 1 } },
      create: { partnerId, windowStart, count: 1 },
    });
    if (bucket.count > limit)
      throw new HttpException(
        {
          code: "PARTNER_RATE_LIMITED",
          message: "Partner rate limit exceeded",
        },
        429,
      );
    return Math.max(0, limit - bucket.count);
  }
}

function requestMethod(request: PartnerRequest & { method?: string }) {
  return request.method?.toUpperCase() ?? "GET";
}
