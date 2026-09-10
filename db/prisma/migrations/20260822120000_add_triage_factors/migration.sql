-- Per-factor breakdown behind each risk score. Additive and nullable: rows
-- written before this migration simply have no breakdown until their next
-- rescore, which the sweep does on its own.
ALTER TABLE "triage_scores" ADD COLUMN "factors" JSONB;
