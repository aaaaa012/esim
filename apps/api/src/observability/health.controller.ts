import { Controller, Get } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../infrastructure/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready')
  async ready() {
    let database: 'up' | 'not-configured' | 'down' = 'not-configured';
    let databaseLatencyMs: number | undefined;
    if (this.prisma.enabled) {
      try {
        const started = Date.now();
        await this.prisma.$queryRaw`SELECT 1`;
        database = 'up';
        databaseLatencyMs = Date.now() - started;
      } catch {
        database = 'down';
      }
    }
    let redis: 'up' | 'not-configured' | 'down' = 'not-configured';
    let redisLatencyMs: number | undefined;
    if (process.env.REDIS_URL) {
      const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true, lazyConnect: true, connectTimeout: 2000 });
      try {
        const started = Date.now();
        await client.connect();
        await client.ping();
        redis = 'up';
        redisLatencyMs = Date.now() - started;
      } catch {
        redis = 'down';
      } finally {
        client.disconnect();
      }
    }
    const ready = database !== 'down' && redis !== 'down';
    return {
      status: ready ? 'ready' : 'degraded',
      checks: {
        api: 'up',
        database,
        ...(databaseLatencyMs !== undefined ? { databaseLatencyMs } : {}),
        redis,
        ...(redisLatencyMs !== undefined ? { redisLatencyMs } : {}),
      },
    };
  }
}