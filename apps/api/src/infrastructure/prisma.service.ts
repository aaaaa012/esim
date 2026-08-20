import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  readonly enabled =
    process.env.PERSISTENCE_MODE === "prisma" &&
    Boolean(process.env.DATABASE_URL);

  constructor() {
    super({
      transactionOptions: {
        maxWait: 10000,
        timeout: 30000,
      },
    });
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log(
        "Prisma persistence disabled; using the local in-memory workflow store",
      );
      return;
    }
    await this.$connect();
    this.logger.log("CockroachDB connection established");
  }

  async onModuleDestroy() {
    if (this.enabled) await this.$disconnect();
  }
}
