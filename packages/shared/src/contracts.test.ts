import { describe, expect, it } from 'vitest';
import { travelerSchema } from './schemas.js';

describe('travelerSchema', () => {
  it('rejects malformed traveler data', () => {
    expect(travelerSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});
