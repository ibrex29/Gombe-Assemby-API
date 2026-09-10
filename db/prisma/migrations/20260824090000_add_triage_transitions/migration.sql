-- Every risk band / outlook change, kept so the board can show what moved.
CREATE TABLE "triage_transitions" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "level" "CollationLevel" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "scopeName" TEXT NOT NULL,
    "stateId" TEXT,
    "fromRisk" "TriageRiskLevel" NOT NULL,
    "toRisk" "TriageRiskLevel" NOT NULL,
    "fromOutlook" "TriageOutlook" NOT NULL,
    "toOutlook" "TriageOutlook" NOT NULL,
    "compositeScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "triage_transitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "triage_transitions_campaignId_createdAt_idx"
    ON "triage_transitions"("campaignId", "createdAt");
CREATE INDEX "triage_transitions_campaignId_scopeType_scopeId_createdAt_idx"
    ON "triage_transitions"("campaignId", "scopeType", "scopeId", "createdAt");

ALTER TABLE "triage_transitions" ADD CONSTRAINT "triage_transitions_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
