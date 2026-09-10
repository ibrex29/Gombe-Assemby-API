-- Pulse source: inferred check-in / heartbeat / result / incident vs manual sitrep.

CREATE TYPE "PulseSource" AS ENUM ('MANUAL', 'CHECK_IN', 'HEARTBEAT', 'RESULT', 'INCIDENT');

ALTER TABLE "situation_updates"
  ADD COLUMN "source" "PulseSource" NOT NULL DEFAULT 'MANUAL';

ALTER TABLE "polling_unit_pulses"
  ADD COLUMN "source" "PulseSource" NOT NULL DEFAULT 'MANUAL';
