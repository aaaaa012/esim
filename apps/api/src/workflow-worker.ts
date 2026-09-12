import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ProductionResilienceService } from "./jobs/production-resilience.service.js";
import { requireProcessRole } from "./common/process-role.js";

async function bootstrap() {
  requireProcessRole("workflow-worker");
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const resilience = app.get(ProductionResilienceService);
  const beat = () =>
    void resilience
      .heartbeat("workflow-worker", {
        queues: [
          "provisioning",
          "payments",
          "provider-callbacks",
          "notifications",
          "reconciliation",
          "partner-webhooks",
        ],
      })
      .catch((error) =>
        new Logger("WorkflowWorker").warn(
          error instanceof Error ? error.message : "Heartbeat failed",
        ),
      );
  beat();
  const timer = setInterval(beat, 30_000);
  timer.unref();
  new Logger("WorkflowWorker").log("Workflow and reconciliation worker ready");
}

if (!process.env.NODE_ENV)
  throw new Error(
    "NODE_ENV is required for the workflow worker (development, test, staging, or production).",
  );

void bootstrap();
