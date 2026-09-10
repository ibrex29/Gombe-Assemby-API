-- AlterTable
ALTER TABLE "irev_geo_mappings" ADD COLUMN "lastCatalogedAt" TIMESTAMP(3);
ALTER TABLE "irev_geo_mappings" ADD COLUMN "lastCatalogAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "irev_geo_mappings_lastCatalogedAt_idx" ON "irev_geo_mappings"("lastCatalogedAt");

-- CreateIndex
CREATE INDEX "irev_geo_mappings_lastCatalogAttemptAt_idx" ON "irev_geo_mappings"("lastCatalogAttemptAt");
