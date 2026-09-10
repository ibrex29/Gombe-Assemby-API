-- Append-only: who took responsibility for a hot scope, and when.
CREATE TABLE "triage_acknowledgements" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "level" "CollationLevel" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "riskLevel" "TriageRiskLevel" NOT NULL,
    "compositeScore" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "triage_acknowledgements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "triage_acknowledgements_campaignId_scopeType_scopeId_createdAt_idx"
    ON "triage_acknowledgements"("campaignId", "scopeType", "scopeId", "createdAt");

ALTER TABLE "triage_acknowledgements" ADD CONSTRAINT "triage_acknowledgements_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "triage_acknowledgements" ADD CONSTRAINT "triage_acknowledgements_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
