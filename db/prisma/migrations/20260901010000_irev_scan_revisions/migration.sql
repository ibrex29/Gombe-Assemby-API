-- CreateTable
CREATE TABLE "irev_scan_revisions" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "documentUrl" TEXT,
    "documentHash" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "ocrExtract" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "irev_scan_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "irev_scan_revisions_snapshotId_idx" ON "irev_scan_revisions"("snapshotId");

-- CreateIndex
CREATE INDEX "irev_scan_revisions_snapshotId_observedAt_idx" ON "irev_scan_revisions"("snapshotId", "observedAt");

-- AddForeignKey
ALTER TABLE "irev_scan_revisions" ADD CONSTRAINT "irev_scan_revisions_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "irev_pu_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
