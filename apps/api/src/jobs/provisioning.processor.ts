import { Injectable, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import { OrdersService } from "../modules/orders/orders.service.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";

@Injectable()
export class ProvisioningProcessor implements OnModuleInit {
  constructor(
    private readonly queues: QueueService,
    private readonly orders: OrdersService,
  ) {}
  onModuleInit() {
    if (process.env.PROCESS_ROLE === "api") return;
    this.queues.registerWorker(
      QUEUES.provisioning,
      async (job: Job<{ orderId: string }>) => {
        if (job.name === "advance-approved-order")
          return this.orders.advanceApprovedIfNeeded(job.data.orderId);
        return this.orders.processProvisioning(
          job.data.orderId,
          job.attemptsMade + 1,
          job.attemptsMade + 1 >= 3,
        );
      },
    );
  }
}
