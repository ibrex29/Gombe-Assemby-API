-- CreateEnum
CREATE TYPE "IrevPuSnapshotStatus" AS ENUM ('NOT_ON_IREV', 'FETCHED', 'OCR_READY', 'OCR_FAILED');

-- AlterTable
ALTER TABLE "collation_results" ADD COLUMN "irevVerification" JSONB;
ALTER TABLE "collation_results" ADD COLUMN "irevVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "irev_election_configs" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "irevElectionId" TEXT NOT NULL,
    "electionLabel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "irev_election_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "irev_geo_mappings" (
    "id" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "irevWardId" TEXT NOT NULL,
    "irevLgaId" TEXT,
    "irevStateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "irev_geo_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "irev_pu_snapshots" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "pollingUnitId" TEXT NOT NULL,
    "irevPuId" TEXT,
    "documentUrl" TEXT,
    "documentHash" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "ocrExtract" JSONB,
    "status" "IrevPuSnapshotStatus" NOT NULL DEFAULT 'FETCHED',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "irev_pu_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "irev_election_configs_campaignId_key" ON "irev_election_configs"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "irev_geo_mappings_wardId_key" ON "irev_geo_mappings"("wardId");

-- CreateIndex
CREATE INDEX "irev_geo_mappings_irevWardId_idx" ON "irev_geo_mappings"("irevWardId");

-- CreateIndex
CREATE INDEX "irev_pu_snapshots_campaignId_pollingUnitId_key" ON "irev_pu_snapshots"("campaignId", "pollingUnitId");

-- CreateIndex
CREATE INDEX "irev_pu_snapshots_campaignId_status_idx" ON "irev_pu_snapshots"("campaignId", "status");

-- CreateIndex
CREATE INDEX "irev_pu_snapshots_pollingUnitId_idx" ON "irev_pu_snapshots"("pollingUnitId");

-- AddForeignKey
ALTER TABLE "irev_election_configs" ADD CONSTRAINT "irev_election_configs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "irev_geo_mappings" ADD CONSTRAINT "irev_geo_mappings_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "wards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "irev_pu_snapshots" ADD CONSTRAINT "irev_pu_snapshots_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "irev_pu_snapshots" ADD CONSTRAINT "irev_pu_snapshots_pollingUnitId_fkey" FOREIGN KEY ("pollingUnitId") REFERENCES "polling_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
