import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { QueueService } from "./jobs/queue.service.js";
import { PassportOcrProcessor } from "./jobs/passport-ocr.processor.js";
import { CryptoService } from "./infrastructure/crypto.service.js";
import { CloudinaryStorageService } from "./infrastructure/cloudinary-storage.service.js";
import { PrismaService } from "./infrastructure/prisma.service.js";
import { validateEnv } from "./infrastructure/env-validation.js";
import { PassportVerificationService } from "./modules/orders/passport-verification.service.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "apps/api/.env", "../../.env"],
      validate: validateEnv,
    }),
  ],
  providers: [
    PrismaService,
    CryptoService,
    CloudinaryStorageService,
    QueueService,
    PassportVerificationService,
    PassportOcrProcessor,
  ],
})
export class OcrWorkerModule {}
