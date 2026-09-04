import { ConflictException } from "@nestjs/common";

/** The initial purchase owns the physical eSIM; later purchases never transfer it. */
export function resolveRechargeOwner<
  T extends { customerId: string; id: string },
>(originals: T[]): T {
  if (originals.length !== 1)
    throw new ConflictException(
      "This eSIM's ownership needs operations review before recharge",
    );
  return originals[0]!;
}

export type RechargeRecoveryOutbox = {
  recipient: string;
  recipientHash: string;
  tokenHash: string;
  expiresAt: string;
  recoveryUrlEncrypted: string;
};
