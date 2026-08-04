import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { OrdersService } from '../modules/orders/orders.service.js';
import { QueueService } from './queue.service.js';
import { QUEUES } from './queues.js';

@Injectable()
export class ProvisioningProcessor implements OnModuleInit {
  constructor(private readonly queues: QueueService, private readonly orders: OrdersService) {}
  onModuleInit() { this.queues.registerWorker(QUEUES.provisioning, async (job: Job<{ orderId: string }>) => this.orders.processProvisioning(job.data.orderId, job.attemptsMade + 1, job.attemptsMade + 1 >= 3)); }
}
