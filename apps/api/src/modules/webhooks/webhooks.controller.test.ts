import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { PrismaService } from '../../infrastructure/prisma.service.js';
import type { QueueService } from '../../jobs/queue.service.js';
import type { ClerkSyncService } from '../identity/clerk-sync.service.js';
import { WebhooksController } from './webhooks.controller.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TRANSATEL_WEBHOOK_SECRET;
});

function controller(processedAt: Date | null = null) {
  const prisma = {
    enabled: true,
    webhookEvent: {
      findUnique: vi.fn().mockResolvedValue({ processedAt }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
  const queues = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) } as unknown as QueueService;
  return {
    value: new WebhooksController(prisma, queues, {} as ClerkSyncService),
    prisma,
    queues,
  };
}

describe('WebhooksController connectivity inbox', () => {
  it('verifies the signature against the exact raw bytes', async () => {
    process.env.TRANSATEL_WEBHOOK_SECRET = 'secret';
    const rawBody = Buffer.from('{\n  "header": {"eventId":"event-12345"}\n}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(rawBody).digest('hex')}`;
    const { value, queues } = controller(null);

    const result = await value.connectivity(
      'transatel',
      { header: { eventId: 'event-12345' } },
      { 'x-tsl-signature-256': signature },
      { rawBody } as RawBodyRequest<Request>,
    );

    expect(result).toEqual({ accepted: true, queued: true });
    expect(queues.add).toHaveBeenCalledWith('provider-callbacks', 'connectivity-callback', { provider: 'transatel', eventId: 'event-12345' }, 'transatel:event-12345');
  });

  it('re-enqueues a duplicate inbox row that has not been processed', async () => {
    const { value, prisma, queues } = controller(null);
    await value.connectivity('TRANSATEL', { eventId: 'event-12345' }, {}, {} as RawBodyRequest<Request>);
    expect(prisma.webhookEvent.upsert).not.toHaveBeenCalled();
    expect(queues.add).toHaveBeenCalledOnce();
  });

  it('does not re-enqueue an event that was successfully processed', async () => {
    const { value, queues } = controller(new Date());
    const result = await value.connectivity('transatel', { eventId: 'event-12345' }, {}, {} as RawBodyRequest<Request>);
    expect(result).toEqual({ accepted: true, duplicate: true });
    expect(queues.add).not.toHaveBeenCalled();
  });
});
