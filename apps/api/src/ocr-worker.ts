import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OcrWorkerModule } from "./ocr-worker.module.js";
import { ProductionResilienceService } from "./jobs/production-resilience.service.js";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OcrWorkerModule, {
    bufferLogs: true,
  });
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

void bootstrap();
