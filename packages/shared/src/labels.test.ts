import { describe, expect, it } from 'vitest';
import { orderStatusLabel, documentStatusLabel, notificationTemplateLabel, humanize } from './labels.js';

describe('customer-facing status labels', () => {
  it('never leaks raw enum codes for order statuses', () => {
    const statuses = ['DRAFT', 'PAYMENT_PENDING', 'PROVISIONING', 'QR_READY', 'COMPLETED', 'PROVISIONING_FAILED', 'REFUND_PENDING'];
    for (const status of statuses) {
      const label = orderStatusLabel(status);
      expect(label).not.toContain('_');
      expect(label).not.toBe(status);
    }
  });

  it('presents QR_READY as ready to install, not as still processing', () => {
    expect(orderStatusLabel('QR_READY')).toBe('Ready to install');
    expect(orderStatusLabel('PROVISIONING')).toBe('Activating');
  });

  it('falls back to a readable phrase for unknown codes', () => {
    expect(orderStatusLabel('SOME_NEW_STATE')).toBe('Some new state');
    expect(orderStatusLabel(null)).toBe('');
    expect(orderStatusLabel(undefined)).toBe('');
  });

  it('keeps document and notification labels human-readable', () => {
    expect(documentStatusLabel('REUPLOAD_REQUIRED')).toBe('Re-upload needed');
    expect(notificationTemplateLabel('QR_READY')).toBe('Your eSIM is ready');
    expect(humanize('PLAN_EXPIRED')).toBe('Plan expired');
  });
});
