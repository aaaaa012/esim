import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnv } from "./infrastructure/env-validation.js";
import { HealthController } from "./observability/health.controller.js";
import { MetricsController } from "./observability/metrics.controller.js";
import { MetricsService } from "./observability/metrics.service.js";
import {
  CatalogController,
  CatalogService,
} from "./modules/catalog/catalog.controller.js";
import {
  OrdersController,
  OperationsController,
} from "./modules/orders/orders.controller.js";
import { OrdersService } from "./modules/orders/orders.service.js";
import { GuestOrdersController } from "./modules/orders/guest-orders.controller.js";
import { PaymentsController } from "./modules/payments/payments.controller.js";
import { PaymentsService } from "./modules/payments/payments.service.js";
import { KhaltiGateway } from "./modules/payments/gateways/khalti.gateway.js";
import { PaymentSimulatorGateway } from "./modules/payments/gateways/simulator.gateway.js";
import { CryptoService } from "./infrastructure/crypto.service.js";
import {
  OperationsIntegrationEventsController,
  OperationsIntegrationLogsController,
  OperationsProvisioningOperationsController,
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
import { PartnerService } from "./modules/partners/partner.service.js";
import { PartnerAdminController } from "./modules/partners/partner-admin.controller.js";
import { PartnerAdminService } from "./modules/partners/partner-admin.service.js";
import { PartnerCheckoutController } from "./modules/partners/partner-checkout.controller.js";
import { PartnerWebhookProcessor } from "./jobs/partner-webhook.processor.js";
import { ConnectivityService } from "./modules/integration/connectivity.service.js";
import { AurigaMockProvider } from "./modules/integration/auriga-mock.provider.js";
import { TransatelProvider } from "./modules/integration/transatel.provider.js";
import { NotificationController } from "./modules/notification/notification.controller.js";
import { NotificationService } from "./modules/notification/notification.service.js";
import { EMAIL_CHANNEL } from "./modules/notification/email.channel.js";
import { ResendEmailChannel } from "./modules/notification/resend-email.channel.js";
import { WhatsappChannel } from "./modules/notification/whatsapp.channel.js";
import { QrPdfService } from "./modules/notification/qr-pdf.service.js";
import { IntegrationProcessor } from "./jobs/integration.processor.js";
import { ReconciliationService } from "./jobs/reconciliation.service.js";
import { AuthController } from "./modules/identity/auth.controller.js";
import { AccountGuard } from "./common/auth.guard.js";
import { PassportVerificationRateLimitGuard } from "./common/passport-verification.rate-limit.guard.js";
import { RateLimitGuard } from "./common/rate-limit.guard.js";
import { CustomerEsimsController } from "./modules/esims/customer-esims.controller.js";
import { CustomerEsimsService } from "./modules/esims/customer-esims.service.js";
import { TransatelOperationsController } from "./modules/integration/transatel-operations.controller.js";
import { TransatelOperationsService } from "./modules/integration/transatel-operations.service.js";
import {
  PartnerShowcaseAdminController,
  PartnerShowcasePublicController,
} from "./modules/showcase/partner-showcase.controller.js";
import { PartnerShowcaseService } from "./modules/showcase/partner-showcase.service.js";
import { ManualRefundsController } from "./modules/payments/manual-refunds.controller.js";
import { ManualRefundsService } from "./modules/payments/manual-refunds.service.js";
import { PaymentDisputesController } from "./modules/payments/payment-disputes.controller.js";
import { PaymentDisputesService } from "./modules/payments/payment-disputes.service.js";
import { ProductionResilienceService } from "./jobs/production-resilience.service.js";
import { AttentionController } from "./modules/operations/attention.controller.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "apps/api/.env", "../../.env"],
      validate: validateEnv,
    }),
  ],
  controllers: [
    HealthController,
    MetricsController,
    AuthController,
    CatalogController,
    OrdersController,
    OperationsController,
    GuestOrdersController,
    InventoryController,
    AdminController,
    PaymentsController,
    WebhooksController,
    OperationsIntegrationEventsController,
    OperationsIntegrationLogsController,
    OperationsProvisioningOperationsController,
    PartnersController,
    PartnerAdminController,
    PartnerCheckoutController,
    NotificationController,
    CustomerEsimsController,
    TransatelOperationsController,
    PartnerShowcaseAdminController,
    PartnerShowcasePublicController,
    ManualRefundsController,
    PaymentDisputesController,
    AttentionController,
  ],
  providers: [
    AccountGuard,
    RateLimitGuard,
    PassportVerificationRateLimitGuard,
    CatalogService,
    OrdersService,
    OrdersPersistenceService,
    InventoryService,
    AdminService,
    PaymentsService,
    KhaltiGateway,
    PaymentSimulatorGateway,
    AurigaMockProvider,
    TransatelProvider,
    ConnectivityService,
    PartnerService,
    PartnerAdminService,
    PartnerWebhookProcessor,
    CryptoService,
    PrismaService,
    CloudinaryStorageService,
    QueueService,
    ProvisioningProcessor,
    IntegrationProcessor,
    ReconciliationService,
    MetricsService,
    ClerkSyncService,
    PartnerAuthGuard,
    NotificationService,
    ResendEmailChannel,
    { provide: EMAIL_CHANNEL, useExisting: ResendEmailChannel },
    WhatsappChannel,
    QrPdfService,
    CustomerEsimsService,
    TransatelOperationsService,
    PartnerShowcaseService,
    ManualRefundsService,
    PaymentDisputesService,
    ProductionResilienceService,
  ],
})
export class AppModule {}
