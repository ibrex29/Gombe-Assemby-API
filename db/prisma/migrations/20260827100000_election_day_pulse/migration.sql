-- Election Day Pulse: process + rival-play snapshots, latest state per PU.

CREATE TYPE "ElectionDayPhase" AS ENUM ('CHECKED_IN', 'MATERIALS_READY', 'OPENED', 'VOTING', 'CLOSED', 'COUNTING');
CREATE TYPE "PulseAtmosphere" AS ENUM ('CALM', 'TENSE', 'DISRUPTED');
CREATE TYPE "PulseBvasStatus" AS ENUM ('WORKING', 'SLOW', 'DOWN', 'NOT_SEEN');
CREATE TYPE "PulseQueue" AS ENUM ('NONE', 'SHORT', 'LONG');
CREATE TYPE "PulseTurnoutBand" AS ENUM ('LOW', 'NORMAL', 'HIGH');
CREATE TYPE "RivalMobilization" AS ENUM ('NONE', 'LIGHT', 'HEAVY');
CREATE TYPE "CrowdLean" AS ENUM ('OURS', 'THEIRS', 'MIXED', 'THIN');
CREATE TYPE "WhoLooksAhead" AS ENUM ('US', 'RIVAL', 'UNCLEAR');
CREATE TYPE "RivalTactic" AS ENUM ('INDUCEMENT', 'INTIMIDATION', 'QUEUE_STACKING', 'UNAUTHORIZED_PERSONNEL', 'PARALLEL_STRUCTURE', 'LEGAL_MEDIA_PRESENT', 'DISRUPTION');
CREATE TYPE "ObservedConfidence" AS ENUM ('WATCHING', 'PARTIAL', 'NEAR_FINAL');

ALTER TABLE "situation_updates"
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "phase" "ElectionDayPhase",
  ADD COLUMN "atmosphere" "PulseAtmosphere",
  ADD COLUMN "bvasStatus" "PulseBvasStatus",
  ADD COLUMN "queue" "PulseQueue",
  ADD COLUMN "materialsComplete" BOOLEAN,
  ADD COLUMN "securityPresent" BOOLEAN,
  ADD COLUMN "turnoutBand" "PulseTurnoutBand",
  ADD COLUMN "estimatedAccredited" INTEGER,
  ADD COLUMN "rivalAgentPresent" BOOLEAN,
  ADD COLUMN "rivalMobilization" "RivalMobilization",
  ADD COLUMN "crowdLean" "CrowdLean",
  ADD COLUMN "whoLooksAhead" "WhoLooksAhead",
  ADD COLUMN "rivalTactics" "RivalTactic"[] DEFAULT ARRAY[]::"RivalTactic"[],
  ADD COLUMN "observedPartyResults" JSONB,
  ADD COLUMN "observedConfidence" "ObservedConfidence",
  ADD COLUMN "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "situation_updates"
SET "phase" = CASE "status"
  WHEN 'REPORTING' THEN 'COUNTING'::"ElectionDayPhase"
  WHEN 'CLOSED' THEN 'CLOSED'::"ElectionDayPhase"
  ELSE 'VOTING'::"ElectionDayPhase"
END
WHERE "phase" IS NULL;

CREATE TABLE "polling_unit_pulses" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "pollingUnitId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "status" "SituationStatus" NOT NULL,
    "phase" "ElectionDayPhase" NOT NULL,
    "atmosphere" "PulseAtmosphere",
    "bvasStatus" "PulseBvasStatus",
    "queue" "PulseQueue",
    "materialsComplete" BOOLEAN,
    "securityPresent" BOOLEAN,
    "turnoutBand" "PulseTurnoutBand",
    "estimatedAccredited" INTEGER,
    "rivalAgentPresent" BOOLEAN,
    "rivalMobilization" "RivalMobilization",
    "crowdLean" "CrowdLean",
    "whoLooksAhead" "WhoLooksAhead",
    "rivalTactics" "RivalTactic"[] DEFAULT ARRAY[]::"RivalTactic"[],
    "observedPartyResults" JSONB,
    "observedConfidence" "ObservedConfidence",
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "lastPulseAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polling_unit_pulses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "polling_unit_pulses_campaignId_pollingUnitId_key" ON "polling_unit_pulses"("campaignId", "pollingUnitId");
CREATE INDEX "polling_unit_pulses_campaignId_phase_lastPulseAt_idx" ON "polling_unit_pulses"("campaignId", "phase", "lastPulseAt");
CREATE INDEX "polling_unit_pulses_pollingUnitId_idx" ON "polling_unit_pulses"("pollingUnitId");
CREATE INDEX "situation_updates_campaignId_idx" ON "situation_updates"("campaignId");
CREATE INDEX "situation_updates_phase_idx" ON "situation_updates"("phase");

ALTER TABLE "situation_updates"
  ADD CONSTRAINT "situation_updates_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "polling_unit_pulses"
  ADD CONSTRAINT "polling_unit_pulses_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "polling_unit_pulses"
  ADD CONSTRAINT "polling_unit_pulses_pollingUnitId_fkey"
  FOREIGN KEY ("pollingUnitId") REFERENCES "polling_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "polling_unit_pulses"
  ADD CONSTRAINT "polling_unit_pulses_reportedById_fkey"
  FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
