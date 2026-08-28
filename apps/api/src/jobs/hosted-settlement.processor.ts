import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Job } from "bullmq";
import { PartnerService } from "../modules/partners/partner.service.js";
import { QueueService } from "./queue.service.js";
import { QUEUES } from "./queues.js";

/**
 * Settles the partner deposit reserved for a hosted checkout link once the
 * order reaches a terminal state: capture on delivery success, release on
 * delivery failure or cancellation. `OrdersService` enqueues the job at the
 * terminal save sites; the reconciliation cycle runs `reconcileHostedDeposits`
 * as a safety net, so settlement is not lost when the queue is unavailable.
 */
@Injectable()
export class HostedSettlementProcessor implements OnModuleInit {
  private readonly logger = new Logger(HostedSettlementProcessor.name);
  constructor(
    private readonly queues: QueueService,
    private readonly partners: PartnerService,
  ) {}
  onModuleInit() {
    if (process.env.PROCESS_ROLE === "api") return;
    this.queues.registerWorker(
      QUEUES.partnerHosted,
      async (job: Job<{ orderId: string; outcome?: "CAPTURE" | "RELEASE" }>) => {
        if (job.name === "release-expired")
          return this.partners.releaseExpiredHostedReservations(new Date());
        try {
          const { orderId } = job.data;
          const result = await this.partners.settleHostedReservation(
            orderId,
            job.data.outcome,
          );
          if (result.action === "SKIPPED") {
            this.logger.debug(
              `Hosted settlement skipped for ${orderId}: ${result.reason}`,
            );
          }
          return result;
        } catch (error) {
          this.logger.error(
            `Hosted settlement failed for order ${job.data.orderId}: ${
              error instanceof Error ? error.message : "unknown"
            }`,
          );
          throw error;
        }
      },
    );
  }
}