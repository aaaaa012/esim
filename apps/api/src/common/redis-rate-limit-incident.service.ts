import { Inject, Injectable, Logger } from "@nestjs/common";
import { AttentionCaseStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { EMAIL_CHANNEL, type EmailChannel } from "../modules/notification/email.channel.js";
import { MetricsService } from "../observability/metrics.service.js";

const DEDUPE_KEY = "infrastructure:redis-rate-limit";
const LOCAL_ALERT_COOLDOWN_MS = 15 * 60_000;

@Injectable()
export class RedisRateLimitIncidentService {
  private readonly logger = new Logger(RedisRateLimitIncidentService.name);
  private locallyDegraded = false;
  private lastLocalAlertAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Inject(EMAIL_CHANNEL) private readonly email: EmailChannel,
  ) {}

  async degraded(reason: unknown) {
    this.metrics.setRedisRateLimitDegraded(true);
    this.metrics.recordFailure("redis", "rate-limit-degraded");
    if (!this.locallyDegraded) {
      this.locallyDegraded = true;
      this.logger.error("Redis rate limiting is unavailable; strict local fallback enabled");
    }

    let shouldAlert = false;
    if (this.prisma.enabled) {
      try {
        const reopened = await this.prisma.attentionCase.updateMany({
          where: { dedupeKey: DEDUPE_KEY, status: AttentionCaseStatus.RESOLVED },
          data: {
            status: AttentionCaseStatus.OPEN,
            severity: "CRITICAL",
            summary: "Redis rate limiting is unavailable",
            detail: "API requests are using the strict per-process fallback.",
            failureCategory: "REDIS_UNAVAILABLE",
            localState: "DEGRADED",
            externalState: "UNREACHABLE",
            resolvedAt: null,
            resolution: null,
            retryCount: { increment: 1 },
          },
        });
        shouldAlert = reopened.count === 1;
        if (!shouldAlert) {
          try {
            await this.prisma.attentionCase.create({
              data: {
                dedupeKey: DEDUPE_KEY,
                category: "INFRASTRUCTURE",
                severity: "CRITICAL",
                entityType: "Redis",
                entityId: "rate-limit",
                summary: "Redis rate limiting is unavailable",
                detail: "API requests are using the strict per-process fallback.",
                failureCategory: "REDIS_UNAVAILABLE",
                localState: "DEGRADED",
                externalState: "UNREACHABLE",
                availableActions: ["CHECK_REDIS", "CHECK_NETWORK", "CHECK_CREDENTIALS"],
              },
            });
            shouldAlert = true;
          } catch (error) {
            if ((error as { code?: string }).code !== "P2002") throw error;
          }
        }
      } catch {
        shouldAlert = Date.now() - this.lastLocalAlertAt >= LOCAL_ALERT_COOLDOWN_MS;
      }
    } else {
      shouldAlert = Date.now() - this.lastLocalAlertAt >= LOCAL_ALERT_COOLDOWN_MS;
    }

    if (shouldAlert) {
      this.lastLocalAlertAt = Date.now();
      await this.send("CRITICAL: Redis rate limiting unavailable", [
        "Redis could not be reached by the API rate limiter.",
        "Strict per-process fallback limiting is active.",
        "Check Render Key Value health, credentials, networking, and connection limits immediately.",
      ].join("\n"));
    }
    void reason;
  }

  async recovered() {
    if (!this.locallyDegraded) return;
    this.locallyDegraded = false;
    this.metrics.setRedisRateLimitDegraded(false);
    this.logger.log("Redis rate limiting recovered; shared limiting restored");
    let shouldAlert = false;
    if (this.prisma.enabled) {
      try {
        const resolved = await this.prisma.attentionCase.updateMany({
          where: { dedupeKey: DEDUPE_KEY, status: AttentionCaseStatus.OPEN },
          data: {
            status: AttentionCaseStatus.RESOLVED,
            resolvedAt: new Date(),
            resolution: "Redis rate limiting recovered automatically",
            localState: "HEALTHY",
            externalState: "REACHABLE",
          },
        });
        shouldAlert = resolved.count === 1;
      } catch {
        shouldAlert = true;
      }
    } else shouldAlert = true;
    if (shouldAlert)
      await this.send(
        "RECOVERED: Redis rate limiting restored",
        "Shared Redis rate limiting is healthy again; local fallback has been disabled.",
      );
  }

  private async send(subject: string, text: string) {
    const recipients = [process.env.OPS_ALERT_EMAIL, process.env.ADMIN_ALERT_EMAIL]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    await Promise.allSettled(
      [...new Set(recipients)].map((to) =>
        this.email.send({
          to,
          subject,
          text,
          idempotencyKey: `${DEDUPE_KEY}:${subject}:${to}:${this.lastLocalAlertAt}`,
        }),
      ),
    );
  }
}
