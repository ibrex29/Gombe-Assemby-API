-- One campaign, two contests (Governorship + Assembly). Agents are campaign-scoped,
-- not contest-scoped: a polling unit has one active agent for the whole system.

-- Keep the newest active occupant if any duplicate PU seats exist.
DELETE FROM "campaign_memberships" AS older
USING "campaign_memberships" AS newer
WHERE older."isActive" = true
  AND newer."isActive" = true
  AND older."campaignId" = newer."campaignId"
  AND older."scopeType" = 'POLLING_UNIT'
  AND newer."scopeType" = 'POLLING_UNIT'
  AND older."scopeId" IS NOT NULL
  AND older."scopeId" = newer."scopeId"
  AND older."updatedAt" < newer."updatedAt";

DELETE FROM "campaign_memberships" AS a
USING "campaign_memberships" AS b
WHERE a."isActive" = true
  AND b."isActive" = true
  AND a."campaignId" = b."campaignId"
  AND a."scopeType" = 'POLLING_UNIT'
  AND b."scopeType" = 'POLLING_UNIT'
  AND a."scopeId" IS NOT NULL
  AND a."scopeId" = b."scopeId"
  AND a.id < b.id;

CREATE UNIQUE INDEX "campaign_memberships_one_active_pu_agent"
  ON "campaign_memberships" ("campaignId", "scopeId")
  WHERE "isActive" = true
    AND "scopeType" = 'POLLING_UNIT'
    AND "scopeId" IS NOT NULL;

ALTER TABLE "campaign_memberships"
  ADD CONSTRAINT "campaign_memberships_pu_agent_scope_chk"
  CHECK (
    role::text NOT IN ('POLLING_AGENT', 'POLLING_UNIT_OFFICER')
    OR ("scopeType" = 'POLLING_UNIT' AND "scopeId" IS NOT NULL)
  );

CREATE INDEX "campaign_memberships_campaignId_scopeType_scopeId_idx"
  ON "campaign_memberships" ("campaignId", "scopeType", "scopeId");
