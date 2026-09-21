import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Redis } from "ioredis";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { decodeAes256Key } from "../infrastructure/encryption-key.js";
import { ProductionResilienceService } from "../jobs/production-resilience.service.js";

@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resilience: ProductionResilienceService,
  ) {}
  @Get("live") live() {
    return { status: "ok" };
  }
  @Get("ready")
  async ready() {
    let cryptography: "up" | "down" = "up";
    try {
      if (process.env.NODE_ENV === "production")
        decodeAes256Key(process.env.APP_ENCRYPTION_KEY_BASE64);
    } catch {
      cryptography = "down";
    }
    let database: "up" | "not-configured" | "down" = "not-configured";
    let databaseLatencyMs: number | undefined;
    if (this.prisma.enabled) {
      try {
        const started = Date.now();
        await this.prisma.$queryRaw`SELECT 1`;
        database = "up";
        databaseLatencyMs = Date.now() - started;
      } catch {
        database = "down";
      }
    }
    let redis: "up" | "not-configured" | "down" = "not-configured";
    let redisLatencyMs: number | undefined;
    if (process.env.REDIS_URL) {
      const client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: 2000,
      });
      try {
        const started = Date.now();
        await client.connect();
        await client.ping();
        redis = "up";
        redisLatencyMs = Date.now() - started;
      } catch {
        redis = "down";
      } finally {
        client.disconnect();
      }
    }
    const ready =
      database !== "down" && redis !== "down" && cryptography !== "down";
    const result = {
      status: ready ? "ready" : "degraded",
      checks: {
        api: "up",
        database,
        ...(databaseLatencyMs !== undefined ? { databaseLatencyMs } : {}),
        redis,
        cryptography,
        ...(redisLatencyMs !== undefined ? { redisLatencyMs } : {}),
      },
    };
    if (!ready) throw new ServiceUnavailableException(result);
    return result;
  }

  @Get("operational")
  async operational() {
    const health = await this.resilience.platformHealth();
    if (health.status !== "healthy")
      throw new ServiceUnavailableException(health);
    return health;
  }

  @Get("deployment")
  async deployment() {
    const health = await this.resilience.deploymentHealth();
    if (health.status !== "healthy")
      throw new ServiceUnavailableException(health);
    return health;
  }
}
