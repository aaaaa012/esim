import { ForbiddenException, Injectable } from "@nestjs/common";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma.service.js";

const SESSION_TTL_MS = 24 * 60 * 60_000;
const RECOVERY_TTL_MS = 30 * 24 * 60 * 60_000;

type MemoryAccess = {
  orderId: string;
  purpose: "DISPLAY" | "EMAIL";
  recipientHash?: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

@Injectable()
export class GuestOrderAccessService {
  private readonly memory = new Map<string, MemoryAccess>();
  private readonly developmentSecret = randomBytes(32).toString("base64url");

  constructor(private readonly prisma: PrismaService) {}

  createSessionToken(orderId: string) {
    const payload = Buffer.from(
      JSON.stringify({ orderId, expiresAt: Date.now() + SESSION_TTL_MS }),
    ).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  assertSessionToken(orderId: string, token: string) {
    if (!token) throw new ForbiddenException("Guest token is required");
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !this.validSignature(payload, signature))
      throw new ForbiddenException("Invalid or expired guest token");
    let claims: { orderId?: string; expiresAt?: number };
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        orderId?: string;
        expiresAt?: number;
      };
    } catch {
      throw new ForbiddenException("Invalid or expired guest token");
    }
    if (
      claims.orderId !== orderId ||
      !claims.expiresAt ||
      claims.expiresAt <= Date.now()
    )
      throw new ForbiddenException("Invalid or expired guest token");
  }

  createLookupToken(mobile: string) {
    const payload = Buffer.from(
      JSON.stringify({ mobile, expiresAt: Date.now() + 15 * 60_000 }),
    ).toString("base64url");
    return `${payload}.${this.signature(payload)}`;
  }

  mobileFromLookupToken(token: string) {
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !this.validSignature(payload, signature))
      throw new ForbiddenException("Invalid or expired top-up lookup");
    let value: { mobile?: string; expiresAt?: number };
    try {
      value = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        mobile?: string;
        expiresAt?: number;
      };
    } catch {
      throw new ForbiddenException("Invalid or expired top-up lookup");
    }
    if (!value.mobile || !value.expiresAt || value.expiresAt < Date.now())
      throw new ForbiddenException("Invalid or expired top-up lookup");
    return value.mobile;
  }

  async issue(
    orderId: string,
    purpose: "DISPLAY" | "EMAIL",
    recipient?: string,
  ) {
    const recipientHash = recipient
      ? this.hash(recipient.trim().toLowerCase())
      : undefined;
    if (purpose === "EMAIL" && recipientHash) {
      const duplicate = this.prisma.enabled
        ? await this.prisma.guestOrderAccessToken.findFirst({
            where: {
              orderId,
              purpose,
              recipientHash,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            select: { id: true },
          })
        : [...this.memory.values()].find(
            (item) =>
              item.orderId === orderId &&
              item.purpose === purpose &&
              item.recipientHash === recipientHash &&
              !item.revokedAt &&
              item.expiresAt > new Date(),
          );
      if (duplicate) return null;
      await this.revokePurpose(orderId, purpose);
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS);
    if (this.prisma.enabled)
      await this.prisma.guestOrderAccessToken.create({
        data: {
          orderId,
          tokenHash,
          purpose,
          ...(recipientHash ? { recipientHash } : {}),
          expiresAt,
        },
      });
    else
      this.memory.set(tokenHash, {
        orderId,
        purpose,
        ...(recipientHash ? { recipientHash } : {}),
        expiresAt,
        revokedAt: null,
      });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async recover(orderId: string, token: string) {
    if (!token) throw new ForbiddenException("Recovery token is required");
    const tokenHash = this.hash(token);
    const now = new Date();
    let expiresAt: Date;
    if (this.prisma.enabled) {
      const found = await this.prisma.guestOrderAccessToken.findFirst({
        where: {
          orderId,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true, expiresAt: true },
      });
      if (!found)
        throw new ForbiddenException("Invalid or expired recovery link");
      await this.prisma.guestOrderAccessToken.update({
        where: { id: found.id },
        data: { lastUsedAt: now },
      });
      expiresAt = found.expiresAt;
    } else {
      const found = this.memory.get(tokenHash);
      if (
        !found ||
        found.orderId !== orderId ||
        found.revokedAt ||
        found.expiresAt <= now
      )
        throw new ForbiddenException("Invalid or expired recovery link");
      expiresAt = found.expiresAt;
    }
    return {
      token: this.createSessionToken(orderId),
      recoveryExpiresAt: expiresAt.toISOString(),
    };
  }

  async revokeAll(orderId: string) {
    if (this.prisma.enabled) {
      await this.prisma.guestOrderAccessToken.updateMany({
        where: { orderId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return;
    }
    for (const item of this.memory.values())
      if (item.orderId === orderId && !item.revokedAt)
        item.revokedAt = new Date();
  }

  private async revokePurpose(
    orderId: string,
    purpose: "DISPLAY" | "EMAIL",
  ) {
    if (this.prisma.enabled) {
      await this.prisma.guestOrderAccessToken.updateMany({
        where: { orderId, purpose, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return;
    }
    for (const item of this.memory.values())
      if (
        item.orderId === orderId &&
        item.purpose === purpose &&
        !item.revokedAt
      )
        item.revokedAt = new Date();
  }

  private signature(payload: string) {
    return createHmac("sha256", this.secret())
      .update(payload)
      .digest("base64url");
  }

  private validSignature(payload: string, supplied: string) {
    const expected = Buffer.from(this.signature(payload));
    const actual = Buffer.from(supplied);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private secret() {
    const secret = process.env.GUEST_ORDER_SECRET;
    if (!secret && process.env.NODE_ENV === "production")
      throw new Error("GUEST_ORDER_SECRET is required in production");
    return secret ?? this.developmentSecret;
  }
}
