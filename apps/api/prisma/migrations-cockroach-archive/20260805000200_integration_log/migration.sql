-- CreateTable
CREATE TABLE "IntegrationLog" (
    "id" UUID NOT NULL,
    "operation" STRING NOT NULL,
    "method" STRING NOT NULL,
    "endpoint" STRING NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "errorCode" STRING,
    "errorMessage" STRING,
    "correlationId" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationLog_operation_createdAt_idx" ON "IntegrationLog"("operation", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationLog_status_idx" ON "IntegrationLog"("status");
