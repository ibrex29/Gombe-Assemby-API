-- Prisma upsert on IrevPuSnapshot requires a unique constraint, not a plain index.
DROP INDEX IF EXISTS "irev_pu_snapshots_campaignId_pollingUnitId_key";
CREATE UNIQUE INDEX "irev_pu_snapshots_campaignId_pollingUnitId_key" ON "irev_pu_snapshots"("campaignId", "pollingUnitId");
