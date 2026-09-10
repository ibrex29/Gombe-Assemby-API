-- AI assistant read-only role + row-level security.
--
-- The assistant lets an LLM write its own SELECT statements. Three independent
-- layers keep that safe; this migration builds two of them (the third is the
-- app-level column allowlist in src/modules/ai/assistant/sql/allowlist.ts):
--
--   1. Table grants  — the role can only SELECT from allowlisted tables.
--   2. RLS policies  — campaign-scoped tables are filtered to one campaign,
--                      taken from the `app.campaign_id` setting the executor
--                      sets per transaction.
--
-- The role is created NOLOGIN here on purpose. LOGIN + password is granted per
-- environment by infra/scripts/setup-ai-readonly.sh (`make db-ai-role`) so no
-- credential is ever committed.
--
-- Policies are scoped `TO electromon_ai_readonly`. The application role owns
-- these tables and therefore bypasses RLS (no FORCE), so app behaviour is
-- unchanged. Verify table ownership before deploying to managed Postgres.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'electromon_ai_readonly') THEN
    CREATE ROLE electromon_ai_readonly NOLOGIN;
  END IF;
END $$;

ALTER ROLE electromon_ai_readonly SET default_transaction_read_only = on;
ALTER ROLE electromon_ai_readonly SET statement_timeout = '5s';

GRANT USAGE ON SCHEMA public TO electromon_ai_readonly;

-- Geographic reference tables: readable, not campaign-scoped.
GRANT SELECT ON states, senatorial_districts, lgas, wards, polling_units
  TO electromon_ai_readonly;

-- Campaign-scoped tables: readable, then filtered by the policies below.
GRANT SELECT ON
  campaigns,
  campaign_memberships,
  field_reports,
  collation_results,
  collation_action_logs,
  support_groups,
  volunteers,
  commitments
TO electromon_ai_readonly;

-- current_setting(..., true) yields NULL when unset, so an executor that forgets
-- to set app.campaign_id sees zero rows rather than every campaign.
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_campaigns ON campaigns
  FOR SELECT TO electromon_ai_readonly
  USING (id = current_setting('app.campaign_id', true));

ALTER TABLE campaign_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_campaign_memberships ON campaign_memberships
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));

ALTER TABLE field_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_field_reports ON field_reports
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));

ALTER TABLE collation_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_collation_results ON collation_results
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));

ALTER TABLE collation_action_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_collation_action_logs ON collation_action_logs
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));

ALTER TABLE support_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_support_groups ON support_groups
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));

ALTER TABLE volunteers ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_volunteers ON volunteers
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));

ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_ro_commitments ON commitments
  FOR SELECT TO electromon_ai_readonly
  USING ("campaignId" = current_setting('app.campaign_id', true));
