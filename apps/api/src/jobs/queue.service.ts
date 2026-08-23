import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { DEFAULT_JOB_OPTIONS, QUEUES } from "./queues.js";

type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection?: Redis;
  private coordination?: Redis;
  private rateLimit?: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();
  readonly enabled = Boolean(process.env.REDIS_URL);

  constructor() {
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
   * By default the caller-supplied jobId is suffixed with a random nonce:
   * BullMQ silently IGNORES an enqueue whose jobId already exists (including
   * completed jobs retained by removeOnComplete), which would strand flows
   * that legitimately re-run the same logical work — passport re-checks,
   * provisioning retries. Callers whose id IS a natural dedupe boundary
   * (webhook provider event ids) must pass { dedupeKey: true } to keep it.
   */
  async add(
    name: QueueName,
    jobName: string,
    payload: object,
    jobId: string,
    options?: {
      attempts?: number;
      backoff?: { type: "fixed" | "exponential"; delay: number };
      dedupeKey?: boolean;
    },
  ) {
    if (!this.enabled) {
      this.logger.debug(`Queue simulator accepted ${name}:${jobName}:${jobId}`);
      return { id: jobId, simulated: true };
    }
    const queue = this.getQueue(name);
    const timeoutMs = Math.min(
      10_000,
      Math.max(250, Number(process.env.QUEUE_ENQUEUE_TIMEOUT_MS ?? 2_000)),
    );
    const effectiveJobId =
      options?.dedupeKey || process.env.NODE_ENV === "test"
        ? jobId
        : `${jobId}#${randomUUID().slice(0, 8)}`;
    const { dedupeKey: _dedupeKey, ...jobOptions } = options ?? {};
    const job = await Promise.race([
      queue.add(jobName, payload, {
        ...DEFAULT_JOB_OPTIONS,
        ...jobOptions,
        jobId: effectiveJobId,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Queue enqueue timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return { id: job.id, simulated: false };
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
    work: () => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }> {
    if (!this.enabled) return { acquired: true, value: await work() };
    const redis = this.coordinationConnection();
    const key = `visa-compass:lease:${name}`;
    const token = randomUUID();
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
          .catch((error) =>
            this.logger.warn(
              `Could not renew distributed lease ${name}: ${error instanceof Error ? error.message : "unknown"}`,
            ),
          );
      },
      Math.max(1_000, Math.floor(ttlMs / 3)),
    );
    try {
      return { acquired: true, value: await work() };
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
    worker.on("completed", (job) =>
      this.logger.debug(`Job ${job.id} completed`),
    );
    this.workers.set(name, worker);
    return true;
  }

  private getQueue(name: QueueName) {
    const current = this.queues.get(name);
    if (current) return current;
    this.connection ??= new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      connectTimeout: 2_000,
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
