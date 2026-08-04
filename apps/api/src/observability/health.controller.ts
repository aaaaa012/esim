import { Controller, Get } from '@nestjs/common';
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
    const ready = database !== 'down';
    return {
      status: ready ? 'ready' : 'degraded',
      checks: {
        api: 'up',
        database,
        ...(databaseLatencyMs !== undefined ? { databaseLatencyMs } : {}),
        redis: process.env.REDIS_URL ? 'configured' : 'not-configured',
      },
    };
  }
}
