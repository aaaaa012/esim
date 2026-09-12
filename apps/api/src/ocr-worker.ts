import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OcrWorkerModule } from "./ocr-worker.module.js";
import { ProductionResilienceService } from "./jobs/production-resilience.service.js";
import { requireProcessRole } from "./common/process-role.js";

async function bootstrap() {
  requireProcessRole("ocr-worker");
  const app = await NestFactory.createApplicationContext(OcrWorkerModule);
  app.enableShutdownHooks();
  const resilience = app.get(ProductionResilienceService);
  const beat = () =>
    void resilience
      .heartbeat("ocr-worker", { concurrency: 1, queue: "documents" })
      .catch(() => undefined);
  beat();
  const timer = setInterval(beat, 30_000);
  timer.unref();
  new Logger("OcrWorker").log("Document OCR worker ready (concurrency 1)");
}

if (!process.env.NODE_ENV)
  throw new Error(
    "NODE_ENV is required for the OCR worker (development, test, staging, or production).",
  );

void bootstrap();
