import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_JOB_OPTIONS, QUEUES } from "./queues.js";
import { PrismaService } from "../infrastructure/prisma.service.js";
import { MetricsService } from "../observability/metrics.service.js";

type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type PassportOcrProvider = "tesseract" | "textract";
export type PassportOcrRoutingReason =
  | "LOCAL_MODE"
  | "TEXTRACT_MODE"
  | "LOCAL_CAPACITY_AVAILABLE"
  | "LOCAL_QUEUE_DEPTH"
  | "LOCAL_QUEUE_AGE"
  | "LOCAL_WORKER_UNHEALTHY"
  | "QUEUE_STATS_UNAVAILABLE";

export type PassportOcrJobPayload =
  | { orderId: string; documentId: string; privateAssetId?: string }
  | { verificationId: string };

/** Compatibility boundary for services whose unit tests use the historical
 * QueueService.add-only stub. Production always takes the routed method. */
export function enqueuePassportOcr(
  queues: QueueService,
  jobName: string,
  payload: PassportOcrJobPayload,
  jobId: string,
  options?: {
    attempts?: number;
    backoff?: { type: "fixed" | "exponential"; delay: number };
    allowDuplicate?: boolean;
  },
) {
  if (typeof queues.addPassportOcr === "function")
    return queues.addPassportOcr(jobName, payload, jobId, options);
  return queues.add(QUEUES.documents, jobName, payload, jobId, options);
}

export function decidePassportOcrRoute(input: {
  mode: "local" | "hybrid" | "textract";
  waiting: number;
  oldestAgeMs: number;
  workerHealthy: boolean;
  waitingLimit: number;
  maxAgeMs: number;
}): {
  provider: PassportOcrProvider;
  routingReason: PassportOcrRoutingReason;
} {
  if (input.mode === "local")
    return { provider: "tesseract", routingReason: "LOCAL_MODE" };
  if (input.mode === "textract")
    return { provider: "textract", routingReason: "TEXTRACT_MODE" };
  if (!input.workerHealthy)
    return { provider: "textract", routingReason: "LOCAL_WORKER_UNHEALTHY" };
  if (input.waiting >= input.waitingLimit)
    return { provider: "textract", routingReason: "LOCAL_QUEUE_DEPTH" };
  if (input.oldestAgeMs >= input.maxAgeMs)
    return { provider: "textract", routingReason: "LOCAL_QUEUE_AGE" };
  return {
    provider: "tesseract",
    routingReason: "LOCAL_CAPACITY_AVAILABLE",
  };
}

/** BullMQ reserves `:` in custom IDs and rejects IDs made only of digits. */
export function bullJobId(jobId: string) {
  if (!jobId.includes(":") && !/^\d+$/.test(jobId)) return jobId;
  return `job-${createHash("sha256").update(jobId).digest("hex")}`;
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection?: Redis;
  private coordination?: Redis;
  private rateLimit?: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();
  readonly enabled = Boolean(process.env.REDIS_URL);

  constructor(
    private readonly prisma?: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    if (process.env.NODE_ENV === "production" && !this.enabled)
      throw new Error(
        "REDIS_URL is required in production for durable order processing",
      );
  }

  async onModuleInit() {
    if (!this.enabled) return;
    const probe = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    try {
      await probe.connect();
      const pong = await probe.ping();
      if (pong !== "PONG") throw new Error("Redis did not answer PONG");
      this.logger.log("Redis connected; durable job queues enabled");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.logger.error(
        `Redis unreachable (${message}); durable job queues disabled`,
      );
      if (process.env.NODE_ENV === "production")
        throw new Error(
          `REDIS_URL is set but Redis is unreachable: ${message}`,
        );
    } finally {
      probe.disconnect();
    }
  }

  /**
   * Enqueues a background job.
   *
   * Caller-supplied job ids are stable deduplication boundaries by default.
   * A caller must explicitly opt into a nonce for a genuinely new attempt.
   */
  async add(
    name: QueueName,
    jobName: string,
    payload: object,
    jobId: string,
    options?: {
      attempts?: number;
      backoff?: { type: "fixed" | "exponential"; delay: number };
      allowDuplicate?: boolean;
    },
  ) {
    if (!this.enabled) {
      this.logger.debug(`Queue simulator accepted ${name}:${jobName}:${jobId}`);
      return { id: jobId, simulated: true };
    }
    const queue = this.getQueue(name);
    const effectiveJobId = bullJobId(
      options?.allowDuplicate ? `${jobId}#${randomUUID().slice(0, 8)}` : jobId,
    );
    const { allowDuplicate: _allowDuplicate, ...jobOptions } = options ?? {};
    const job = await queue.add(jobName, payload, {
      ...DEFAULT_JOB_OPTIONS,
      ...jobOptions,
      jobId: effectiveJobId,
    });
    return { id: job.id, simulated: false };
  }

  /** Routes new passport work before enqueueing so cloud overflow can drain in
   * parallel with the deliberately single-threaded local Tesseract worker. */
  async addPassportOcr(
    jobName: string,
    payload: PassportOcrJobPayload,
    jobId: string,
    options?: {
      attempts?: number;
      backoff?: { type: "fixed" | "exponential"; delay: number };
      allowDuplicate?: boolean;
    },
  ) {
    const { provider, routingReason } = await this.passportOcrRoute();
    this.metrics?.recordOcrRouting(provider, routingReason);
    const queue =
      provider === "textract" ? QUEUES.documentsTextract : QUEUES.documents;
    return this.add(
      queue,
      jobName,
      { ...payload, provider, routingReason },
      `${jobId}-${provider}`,
      options,
    );
  }

  async passportOcrRoute(): Promise<{
    provider: PassportOcrProvider;
    routingReason: PassportOcrRoutingReason;
  }> {
    const configured = process.env.PASSPORT_OCR_MODE;
    const mode =
      configured ??
      (process.env.NODE_ENV === "production" ? "hybrid" : "local");
    if (mode === "local" || !this.enabled)
      return { provider: "tesseract", routingReason: "LOCAL_MODE" };
    if (mode === "textract")
      return { provider: "textract", routingReason: "TEXTRACT_MODE" };

    try {
      const queue = this.getQueue(QUEUES.documents);
      const [counts, oldest, heartbeat] = await Promise.all([
        queue.getJobCounts("waiting"),
        queue.getJobs(["waiting"], 0, 0, true),
        this.prisma?.enabled
          ? this.prisma.workerHeartbeat.findFirst({
              where: { worker: "ocr-worker" },
              orderBy: { lastSeenAt: "desc" },
              select: { lastSeenAt: true, status: true },
            })
          : Promise.resolve(null),
      ]);
      const waiting = counts.waiting ?? 0;
      const oldestAgeMs = oldest[0]?.timestamp
        ? Math.max(0, Date.now() - oldest[0].timestamp)
        : 0;
      const waitingLimit = Number(
        process.env.PASSPORT_OCR_LOCAL_WAITING_LIMIT ?? 2,
      );
      const maxAgeMs = Number(
        process.env.PASSPORT_OCR_LOCAL_MAX_AGE_MS ?? 20_000,
      );
      const heartbeatMaxAgeMs = Number(
        process.env.PASSPORT_OCR_HEARTBEAT_MAX_AGE_MS ?? 75_000,
      );
      const workerHealthy =
        !this.prisma?.enabled ||
        (heartbeat?.status === "RUNNING" &&
          Date.now() - heartbeat.lastSeenAt.getTime() <= heartbeatMaxAgeMs);
      return decidePassportOcrRoute({
        mode: "hybrid",
        waiting,
        oldestAgeMs,
        workerHealthy,
        waitingLimit,
        maxAgeMs,
      });
    } catch (error) {
      this.logger.warn(
        `Could not inspect local OCR capacity; routing to Textract: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return {
        provider: "textract",
        routingReason: "QUEUE_STATS_UNAVAILABLE",
      };
    }
  }

  /**
   * Executes work under a Redis lease. This is used for timer-driven sweeps so
   * multiple API replicas do not independently reconcile the same records.
   * The lease is renewed while the callback runs and released only by its
   * owner. Local development deliberately runs the callback without Redis.
   */
  async withDistributedLock<T>(
    name: string,
    ttlMs: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }> {
    if (!this.enabled)
      return {
        acquired: true,
        value: await work(new AbortController().signal),
      };
    const redis = this.coordinationConnection();
    const key = `visa-compass:lease:${name}`;
    const token = randomUUID();
    const ownership = new AbortController();
    const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired !== "OK") return { acquired: false };
    const renewal = setInterval(
      () => {
        void redis
          .eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0",
            1,
            key,
            token,
            String(ttlMs),
          )
          .then((renewed) => {
            if (Number(renewed) !== 1) ownership.abort();
          })
          .catch((error) => {
            ownership.abort();
            this.logger.warn(
              `Could not renew distributed lease ${name}: ${error instanceof Error ? error.message : "unknown"}`,
            );
          });
      },
      Math.max(1_000, Math.floor(ttlMs / 3)),
    );
    try {
      const value = await work(ownership.signal);
      if (ownership.signal.aborted)
        throw new Error(
          `Distributed lease ${name} was lost while work was running`,
        );
      return { acquired: true, value };
    } finally {
      clearInterval(renewal);
      await redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
          1,
          key,
          token,
        )
        .catch((error) =>
          this.logger.warn(
            `Could not release distributed lease ${name}: ${error instanceof Error ? error.message : "unknown"}`,
          ),
        );
    }
  }

  /** Shared fixed-window counter for API guards. Returns the count and the
   * remaining window TTL so callers can emit standard Retry-After headers. */
  async consumeRateLimit(
    bucket: string,
    windowMs: number,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    if (!this.enabled)
      return { count: 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    const redis = this.rateLimitConnection();
    const key = `visa-compass:rate:${bucket}`;
    const [count, ttl] = (await redis.eval(
      "local count = redis.call('incr', KEYS[1]); if count == 1 or redis.call('pttl', KEYS[1]) < 0 then redis.call('pexpire', KEYS[1], ARGV[1]); end; return { count, redis.call('pttl', KEYS[1]) }",
      1,
      key,
      String(windowMs),
    )) as [number, number];
    return {
      count,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((ttl > 0 ? ttl : windowMs) / 1000),
      ),
    };
  }

  registerWorker(
    name: QueueName,
    processor: (job: Job) => Promise<unknown>,
    options?: { concurrency?: number },
  ) {
    if (!this.enabled || this.workers.has(name)) return false;
    const connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const worker = new Worker(name, processor, {
      connection,
      concurrency:
        options?.concurrency ?? Number(process.env.QUEUE_CONCURRENCY ?? 3),
      stalledInterval: 30_000,
    });
    worker.on("failed", (job, error) =>
      this.logger.error(
        `Job ${job?.id ?? "unknown"} failed after ${job?.attemptsMade ?? 0} attempt(s): ${error?.message ?? "unknown"}`,
      ),
    );
    worker.on("stalled", (jobId) =>
      this.logger.warn(`Job ${jobId} stalled; will be retried by BullMQ`),
    );
    worker.on("error", (error) =>
      this.logger.error(
        `Worker error on ${name}: ${error instanceof Error ? error.message : error}`,
      ),
    );
    worker.on("completed", (job) => {
      this.logger.debug(`Job ${job.id} completed`);
      const outboxId = (job.data as { outboxId?: unknown }).outboxId;
      if (typeof outboxId === "string" && this.prisma?.enabled)
        void this.prisma.outboxMessage
          .updateMany({
            where: { id: outboxId, status: { in: ["ENQUEUED", "DISPATCHED"] } },
            data: { status: "PROCESSED" },
          })
          .catch((error) =>
            this.logger.error(
              `Could not acknowledge outbox ${outboxId}: ${error instanceof Error ? error.message : "unknown"}`,
            ),
          );
    });
    this.workers.set(name, worker);
    return true;
  }

  private getQueue(name: QueueName) {
    const current = this.queues.get(name);
    if (current) return current;
    this.connection ??= new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 2_000,
      commandTimeout: Number(process.env.QUEUE_ENQUEUE_TIMEOUT_MS ?? 2_000),
    });
    const queue = new Queue(name, { connection: this.connection });
    this.queues.set(name, queue);
    return queue;
  }

  async stats() {
    if (!this.enabled) return { enabled: false, queues: [] };
    const queues = [];
    for (const name of Object.values(QUEUES)) {
      const queue = this.getQueue(name);
      const [counts, oldest] = await Promise.all([
        queue.getJobCounts("waiting", "active", "delayed", "failed"),
        queue.getJobs(["waiting", "delayed"], 0, 0, true),
      ]);
      queues.push({
        name,
        ...counts,
        oldestAgeSeconds: oldest[0]?.timestamp
          ? Math.max(0, Math.floor((Date.now() - oldest[0].timestamp) / 1000))
          : 0,
      });
    }
    return { enabled: true, queues };
  }

  async hasJob(name: QueueName, jobId: string) {
    if (!this.enabled) return false;
    const job = await this.getQueue(name).getJob(bullJobId(jobId));
    if (!job) return false;
    return [
      "waiting",
      "active",
      "delayed",
      "prioritized",
      "waiting-children",
    ].includes(await job.getState());
  }

  private coordinationConnection() {
    this.coordination ??= new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    return this.coordination;
  }

  private rateLimitConnection() {
    this.rateLimit ??= new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS ?? 400),
      commandTimeout: Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS ?? 400),
      lazyConnect: false,
    });
    return this.rateLimit;
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all(
      [...this.workers.values()].map((worker) => worker.close()),
    );
    await this.connection?.quit();
    await this.coordination?.quit();
    await this.rateLimit?.quit();
  }
}
