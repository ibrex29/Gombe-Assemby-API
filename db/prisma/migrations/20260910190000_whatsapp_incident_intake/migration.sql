-- CreateEnum
CREATE TYPE "FieldReportSource" AS ENUM ('DASHBOARD', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "WhatsAppInboundStatus" AS ENUM ('RECEIVED', 'IGNORED', 'PROCESSED', 'FAILED');

-- AlterTable
ALTER TABLE "field_reports" ADD COLUMN "source" "FieldReportSource" NOT NULL DEFAULT 'DASHBOARD',
ADD COLUMN "sourceMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "field_reports_sourceMessageId_key" ON "field_reports"("sourceMessageId");

-- CreateIndex
CREATE INDEX "field_reports_source_idx" ON "field_reports"("source");

-- CreateTable
CREATE TABLE "whatsapp_inbound_messages" (
    "id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WhatsAppInboundStatus" NOT NULL DEFAULT 'RECEIVED',
    "ignoreReason" TEXT,
    "fieldReportId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_inbound_messages_wamid_key" ON "whatsapp_inbound_messages"("wamid");

-- CreateIndex
CREATE INDEX "whatsapp_inbound_messages_fromPhone_idx" ON "whatsapp_inbound_messages"("fromPhone");

-- CreateIndex
CREATE INDEX "whatsapp_inbound_messages_status_idx" ON "whatsapp_inbound_messages"("status");

-- CreateIndex
CREATE INDEX "whatsapp_inbound_messages_createdAt_idx" ON "whatsapp_inbound_messages"("createdAt");

-- AddForeignKey
ALTER TABLE "whatsapp_inbound_messages" ADD CONSTRAINT "whatsapp_inbound_messages_fieldReportId_fkey" FOREIGN KEY ("fieldReportId") REFERENCES "field_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
