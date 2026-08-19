import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OcrWorkerModule } from "./ocr-worker.module.js";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OcrWorkerModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();
  new Logger("OcrWorker").log("Document OCR worker ready (concurrency 1)");
}

void bootstrap();
