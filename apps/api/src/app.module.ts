import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./observability/health.controller.js";
import {
  CatalogController,
  CatalogService,
} from "./modules/catalog/catalog.controller.js";
import {
  OrdersController,
  OperationsController,
} from "./modules/orders/orders.controller.js";
import { OrdersService } from "./modules/orders/orders.service.js";
import { PaymentsController } from "./modules/payments/payments.controller.js";
import { PaymentsService } from "./modules/payments/payments.service.js";
import { KhaltiGateway } from "./modules/payments/gateways/khalti.gateway.js";
import { EsewaGateway } from "./modules/payments/gateways/esewa.gateway.js";
import { PaymentSimulatorGateway } from "./modules/payments/gateways/simulator.gateway.js";
import { CryptoService } from "./infrastructure/crypto.service.js";
import {
  OperationsIntegrationEventsController,
  OperationsIntegrationLogsController,
  WebhooksController,
} from "./modules/webhooks/webhooks.controller.js";
import { PrismaService } from "./infrastructure/prisma.service.js";
import { CloudinaryStorageService } from "./infrastructure/cloudinary-storage.service.js";
import { QueueService } from "./jobs/queue.service.js";
import { ClerkSyncService } from "./modules/identity/clerk-sync.service.js";
import { OrdersPersistenceService } from "./modules/orders/orders-persistence.service.js";
import { InventoryController } from "./modules/inventory/inventory.controller.js";
import { InventoryService } from "./modules/inventory/inventory.service.js";
import { AdminController } from "./modules/admin/admin.controller.js";
import { AdminService } from "./modules/admin/admin.service.js";
import { ProvisioningProcessor } from "./jobs/provisioning.processor.js";
import { PartnersController } from "./modules/partners/partners.controller.js";
import { PartnerAuthGuard } from "./modules/partners/partner-auth.guard.js";
import { ConnectivityService } from "./modules/integration/connectivity.service.js";
import { TransatelProvider } from "./modules/integration/transatel.provider.js";
import { NotificationController } from "./modules/notification/notification.controller.js";
import { NotificationService } from "./modules/notification/notification.service.js";
import { GmailChannel } from "./modules/notification/gmail.channel.js";
import { WhatsappChannel } from "./modules/notification/whatsapp.channel.js";
import { QrPdfService } from "./modules/notification/qr-pdf.service.js";
import { IntegrationProcessor } from "./jobs/integration.processor.js";
import { ReconciliationService } from "./jobs/reconciliation.service.js";
import { AuthController } from "./modules/identity/auth.controller.js";
import { AccountGuard } from "./common/auth.guard.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "apps/api/.env", "../../.env"],
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    CatalogController,
    OrdersController,
    OperationsController,
    InventoryController,
    AdminController,
    PaymentsController,
    WebhooksController,
    OperationsIntegrationEventsController,
    OperationsIntegrationLogsController,
    PartnersController,
    NotificationController,
  ],
  providers: [
    AccountGuard,
    CatalogService,
    OrdersService,
    OrdersPersistenceService,
    InventoryService,
    AdminService,
    PaymentsService,
    KhaltiGateway,
    EsewaGateway,
    PaymentSimulatorGateway,
    TransatelProvider,
    ConnectivityService,
    CryptoService,
    PrismaService,
    CloudinaryStorageService,
    QueueService,
    ProvisioningProcessor,
    IntegrationProcessor,
    ReconciliationService,
    ClerkSyncService,
    PartnerAuthGuard,
    NotificationService,
    GmailChannel,
    WhatsappChannel,
    QrPdfService,
  ],
})
export class AppModule {}
