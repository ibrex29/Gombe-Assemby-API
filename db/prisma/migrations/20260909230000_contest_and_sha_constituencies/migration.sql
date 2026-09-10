-- Dual contest: Governorship + State House of Assembly, plus Gombe SHA seats.

CREATE TYPE "ContestType" AS ENUM ('GOVERNORSHIP', 'ASSEMBLY');

ALTER TYPE "ScopeType" ADD VALUE 'CONSTITUENCY';
ALTER TYPE "CollationLevel" ADD VALUE 'CONSTITUENCY';

CREATE TABLE "contests" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" "ContestType" NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "irevElectionId" TEXT,
    "irevElectionLabel" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contests_campaignId_type_key" ON "contests"("campaignId", "type");
CREATE UNIQUE INDEX "contests_campaignId_slug_key" ON "contests"("campaignId", "slug");
CREATE INDEX "contests_campaignId_isDefault_idx" ON "contests"("campaignId", "isDefault");

ALTER TABLE "contests"
  ADD CONSTRAINT "contests_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "contests" ("id", "campaignId", "type", "slug", "label", "irevElectionId", "irevElectionLabel", "isDefault", "createdAt", "updatedAt")
SELECT
  'gov_' || c."id",
  c."id",
  'GOVERNORSHIP',
  'governorship',
  CASE WHEN c."isNational" THEN 'Presidential' ELSE 'Governorship' END,
  cfg."irevElectionId",
  cfg."electionLabel",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "campaigns" c
LEFT JOIN "irev_election_configs" cfg ON cfg."campaignId" = c."id";

CREATE TABLE "state_assembly_constituencies" (
    "id" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "lgaId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "state_assembly_constituencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "state_assembly_constituencies_code_stateId_key" ON "state_assembly_constituencies"("code", "stateId");
CREATE UNIQUE INDEX "state_assembly_constituencies_name_stateId_key" ON "state_assembly_constituencies"("name", "stateId");
CREATE INDEX "state_assembly_constituencies_stateId_idx" ON "state_assembly_constituencies"("stateId");
CREATE INDEX "state_assembly_constituencies_lgaId_idx" ON "state_assembly_constituencies"("lgaId");

ALTER TABLE "state_assembly_constituencies"
  ADD CONSTRAINT "state_assembly_constituencies_stateId_fkey"
  FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "state_assembly_constituencies"
  ADD CONSTRAINT "state_assembly_constituencies_lgaId_fkey"
  FOREIGN KEY ("lgaId") REFERENCES "lgas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "wards" ADD COLUMN "constituencyId" TEXT;
CREATE INDEX "wards_constituencyId_idx" ON "wards"("constituencyId");
ALTER TABLE "wards"
  ADD CONSTRAINT "wards_constituencyId_fkey"
  FOREIGN KEY ("constituencyId") REFERENCES "state_assembly_constituencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "collation_results" ADD COLUMN "contestId" TEXT;
UPDATE "collation_results" r
SET "contestId" = c."id"
FROM "contests" c
WHERE c."campaignId" = r."campaignId" AND c."isDefault" = true;
DELETE FROM "collation_results" WHERE "contestId" IS NULL;
ALTER TABLE "collation_results" ALTER COLUMN "contestId" SET NOT NULL;

DROP INDEX IF EXISTS "collation_results_campaignId_level_scopeType_scopeId_key";
CREATE UNIQUE INDEX "collation_results_campaignId_contestId_level_scopeType_scopeId_key"
  ON "collation_results"("campaignId", "contestId", "level", "scopeType", "scopeId");
DROP INDEX IF EXISTS "collation_results_campaignId_level_status_idx";
CREATE INDEX "collation_results_campaignId_contestId_level_status_idx"
  ON "collation_results"("campaignId", "contestId", "level", "status");

ALTER TABLE "collation_results"
  ADD CONSTRAINT "collation_results_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "irev_pu_snapshots" ADD COLUMN "contestId" TEXT;
UPDATE "irev_pu_snapshots" s
SET "contestId" = c."id"
FROM "contests" c
WHERE c."campaignId" = s."campaignId" AND c."isDefault" = true;
DELETE FROM "irev_pu_snapshots" WHERE "contestId" IS NULL;
ALTER TABLE "irev_pu_snapshots" ALTER COLUMN "contestId" SET NOT NULL;

DROP INDEX IF EXISTS "irev_pu_snapshots_campaignId_pollingUnitId_key";
CREATE UNIQUE INDEX "irev_pu_snapshots_campaignId_contestId_pollingUnitId_key"
  ON "irev_pu_snapshots"("campaignId", "contestId", "pollingUnitId");
DROP INDEX IF EXISTS "irev_pu_snapshots_campaignId_status_idx";
CREATE INDEX "irev_pu_snapshots_campaignId_contestId_status_idx"
  ON "irev_pu_snapshots"("campaignId", "contestId", "status");

ALTER TABLE "irev_pu_snapshots"
  ADD CONSTRAINT "irev_pu_snapshots_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "irev_election_configs" ADD COLUMN "contestId" TEXT;
UPDATE "irev_election_configs" cfg
SET "contestId" = c."id"
FROM "contests" c
WHERE c."campaignId" = cfg."campaignId" AND c."isDefault" = true;
DELETE FROM "irev_election_configs" WHERE "contestId" IS NULL;
ALTER TABLE "irev_election_configs" ALTER COLUMN "contestId" SET NOT NULL;

DROP INDEX IF EXISTS "irev_election_configs_campaignId_key";
CREATE UNIQUE INDEX "irev_election_configs_contestId_key" ON "irev_election_configs"("contestId");
CREATE INDEX "irev_election_configs_campaignId_idx" ON "irev_election_configs"("campaignId");

ALTER TABLE "irev_election_configs"
  ADD CONSTRAINT "irev_election_configs_contestId_fkey"
  FOREIGN KEY ("contestId") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
