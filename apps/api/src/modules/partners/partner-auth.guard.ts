import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export type PartnerRequest = { headers: Record<string, string | undefined>; partner?: { id: string } };

@Injectable()
export class PartnerAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<PartnerRequest>();
    const supplied = request.headers['x-partner-api-key'];
    const configured = this.credentials();
    if (!supplied || !configured.length) throw new UnauthorizedException('Valid partner API key required');
    const suppliedHash = createHash('sha256').update(supplied).digest();
    const match = configured.find((item) => timingSafeEqual(suppliedHash, Buffer.from(item.keyHash, 'hex')));
    if (!match) throw new UnauthorizedException('Valid partner API key required');
    request.partner = { id: match.id };
    return true;
  }

  private credentials(): { id: string; keyHash: string }[] {
    try {
      const value = JSON.parse(process.env.PARTNER_API_KEYS_JSON ?? '[]') as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is { id: string; keyHash: string } => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && /^[a-f0-9]{64}$/i.test(String((item as Record<string, unknown>).keyHash))));
    } catch { return []; }
  }
}
