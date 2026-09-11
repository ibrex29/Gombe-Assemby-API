-- Intelligence SQL can now read contests and Assembly seats.
-- Geography tables are not campaign-scoped; contests are.

GRANT SELECT ON contests, state_assembly_constituencies
  TO electromon_ai_readonly;

ALTER TABLE contests ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_contests ON contests
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));
