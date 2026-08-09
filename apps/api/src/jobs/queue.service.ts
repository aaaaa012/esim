import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queues.js';

type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection?: Redis;
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

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
    await this.connection?.quit();
  }
}
