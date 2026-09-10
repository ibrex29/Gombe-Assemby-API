-- Triage analyzer: deterministic risk scoring per scope.
-- TriageScore holds the latest score; TriageSnapshot is the append-only series.

-- CreateEnum
CREATE TYPE "TriageOutlook" AS ENUM ('WINNING', 'LEANING_WIN', 'TOSSUP', 'LEANING_LOSS', 'LOSING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TriageRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "triage_scores" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "level" "CollationLevel" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "stateId" TEXT,
    "outlook" "TriageOutlook" NOT NULL DEFAULT 'UNKNOWN',
    "riskLevel" "TriageRiskLevel" NOT NULL DEFAULT 'LOW',
    "compositeScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "componentScores" JSONB,
    "drivers" JSONB,
    "inputsHash" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "previousOutlook" "TriageOutlook",
    "previousRiskLevel" "TriageRiskLevel",
    "lastTransitionAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "triage_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_snapshots" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "level" "CollationLevel" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "outlook" "TriageOutlook" NOT NULL,
    "riskLevel" "TriageRiskLevel" NOT NULL,
    "compositeScore" DOUBLE PRECISION NOT NULL,
    "componentScores" JSONB,
    "engineVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "triage_scores_campaignId_level_riskLevel_idx" ON "triage_scores"("campaignId", "level", "riskLevel");
CREATE INDEX "triage_scores_campaignId_stateId_idx" ON "triage_scores"("campaignId", "stateId");
CREATE INDEX "triage_scores_campaignId_compositeScore_idx" ON "triage_scores"("campaignId", "compositeScore");
CREATE UNIQUE INDEX "triage_scores_campaignId_level_scopeType_scopeId_key" ON "triage_scores"("campaignId", "level", "scopeType", "scopeId");
CREATE INDEX "triage_snapshots_campaignId_scopeType_scopeId_computedAt_idx" ON "triage_snapshots"("campaignId", "scopeType", "scopeId", "computedAt");
CREATE INDEX "triage_snapshots_campaignId_computedAt_idx" ON "triage_snapshots"("campaignId", "computedAt");

-- AddForeignKey
ALTER TABLE "triage_scores" ADD CONSTRAINT "triage_scores_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "triage_snapshots" ADD CONSTRAINT "triage_snapshots_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
