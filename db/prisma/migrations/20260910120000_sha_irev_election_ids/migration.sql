-- Per-seat IReV election IDs for State House of Assembly.
-- SHA is one INEC election per constituency, not one statewide ID.

ALTER TABLE "state_assembly_constituencies" ADD COLUMN "irevElectionId" TEXT;

UPDATE "contests"
SET "irevElectionId" = NULL
WHERE "type" = 'ASSEMBLY';
