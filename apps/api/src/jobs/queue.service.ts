import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queues.js';

type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection?: Redis;
  private coordination?: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();
  readonly enabled = Boolean(process.env.REDIS_URL);

  constructor() {
    if (process.env.NODE_ENV === 'production' && !this.enabled)
      throw new Error('REDIS_URL is required in production for durable order processing');
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
      if (pong !== 'PONG') throw new Error('Redis did not answer PONG');
      this.logger.log('Redis connected; durable job queues enabled');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.error(`Redis unreachable (${message}); durable job queues disabled`);
      if (process.env.NODE_ENV === 'production')
        throw new Error(`REDIS_URL is set but Redis is unreachable: ${message}`);
    } finally {
      probe.disconnect();
    }
  }

  async add(name: QueueName, jobName: string, payload: object, jobId: string) {
    if (!this.enabled) {
      this.logger.debug(`Queue simulator accepted ${name}:${jobName}:${jobId}`);
      return { id: jobId, simulated: true };
    }
    const queue = this.getQueue(name);
    const job = await queue.add(jobName, payload, { ...DEFAULT_JOB_OPTIONS, jobId });
    return { id: job.id, simulated: false };
  }

  /**
   * Executes work under a Redis lease. This is used for timer-driven sweeps so
   * multiple API replicas do not independently reconcile the same records.
   * The lease is renewed while the callback runs and released only by its
   * owner. Local development deliberately runs the callback without Redis.
   */
  async withDistributedLock<T>(name: string, ttlMs: number, work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
    if (!this.enabled) return { acquired: true, value: await work() };
    const redis = this.coordinationConnection();
    const key = `visa-compass:lease:${name}`;
    const token = randomUUID();
    const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return { acquired: false };
    const renewal = setInterval(() => {
      void redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0", 1, key, token, String(ttlMs)).catch((error) => this.logger.warn(`Could not renew distributed lease ${name}: ${error instanceof Error ? error.message : 'unknown'}`));
    }, Math.max(1_000, Math.floor(ttlMs / 3)));
    try {
      return { acquired: true, value: await work() };
    } finally {
      clearInterval(renewal);
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, key, token).catch((error) => this.logger.warn(`Could not release distributed lease ${name}: ${error instanceof Error ? error.message : 'unknown'}`));
    }
  }

  /** Shared fixed-window counter for API guards. Returns the count and the
   * remaining window TTL so callers can emit standard Retry-After headers. */
  async consumeRateLimit(bucket: string, windowMs: number): Promise<{ count: number; retryAfterSeconds: number }> {
    if (!this.enabled) return { count: 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    const redis = this.coordinationConnection();
    const key = `visa-compass:rate:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, windowMs);
    const ttl = await redis.pttl(key);
    return { count, retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)) };
  }

  registerWorker(name: QueueName, processor: (job: Job) => Promise<unknown>) {
    if (!this.enabled || this.workers.has(name)) return false;
    const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null, enableReadyCheck: true });
    const worker = new Worker(name, processor, {
      connection,
      concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 3),
      stalledInterval: 30_000,
    });
    worker.on('failed', (job, error) => this.logger.error(`Job ${job?.id ?? 'unknown'} failed after ${job?.attemptsMade ?? 0} attempt(s): ${error?.message ?? 'unknown'}`));
    worker.on('stalled', (jobId) => this.logger.warn(`Job ${jobId} stalled; will be retried by BullMQ`));
    worker.on('error', (error) => this.logger.error(`Worker error on ${name}: ${error instanceof Error ? error.message : error}`));
    worker.on('completed', (job) => this.logger.debug(`Job ${job.id} completed`));
    this.workers.set(name, worker); return true;
  }

  private getQueue(name: QueueName) {
    const current = this.queues.get(name);
    if (current) return current;
    this.connection ??= new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null, enableReadyCheck: true });
    const queue = new Queue(name, { connection: this.connection });
    this.queues.set(name, queue);
    return queue;
  }

  private coordinationConnection() {
    this.coordination ??= new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null, enableReadyCheck: true });
    return this.coordination;
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
    await this.connection?.quit();
    await this.coordination?.quit();
  }
}
