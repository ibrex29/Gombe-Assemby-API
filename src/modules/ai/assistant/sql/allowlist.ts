/**
 * What the assistant is allowed to see and do in SQL.
 *
 * This is the app-level layer of a three-layer guarantee. The other two are the
 * table grants and RLS policies in migration 20260820100000. Column-level
 * secrecy lives here and nowhere else: the database grants are table-level, so
 * dropping a column from ALLOWED_COLUMNS is what actually keeps it unreadable.
 *
 * Postgres note: schema.prisma maps table names to snake_case but leaves column
 * names camelCase, so every column below is case-sensitive and must be
 * double-quoted in SQL.
 */

/** Hard ceiling on rows returned to the model, enforced by rewriting LIMIT. */
export const MAX_ROWS = 200;

/**
 * Columns deliberately withheld, with the reason, so future edits are informed:
 *
 * - Personal contact details (`leaderPhone`, `leaderEmail`, `phoneNumber`,
 *   `email`) — PII with no analytic value.
 * - User foreign keys (`reportedById`, `handledById`, `submittedById`,
 *   `approvedById`, `actorId`, `coordinatorId`, `assignedAgentId`, `userId`) —
 *   the `users` table is excluded entirely, so these are unresolvable ids that
 *   only enable correlation.
 * - `polling_units.notes` — free-text field intelligence.
 * - `collation_results.ocrVerification` — internal advisory JSON that reads
 *   like an official figure if surfaced.
 * - Upload URLs (`photoUrls`, `ec8aPhotoUrls`) and chain internals
 *   (`parentResultId`, `flaggedPollingUnitIds`, `metadata`).
 */
export const ALLOWED_COLUMNS: Record<string, ReadonlySet<string>> = {
  states: new Set(['id', 'name', 'code', 'zone', 'createdAt', 'updatedAt']),
  senatorial_districts: new Set([
    'id',
    'name',
    'stateId',
    'createdAt',
    'updatedAt',
  ]),
  lgas: new Set([
    'id',
    'name',
    'stateId',
    'senatorialDistrictId',
    'createdAt',
    'updatedAt',
  ]),
  wards: new Set([
    'id',
    'name',
    'registrationAreaCode',
    'lgaId',
    'constituencyId',
    'latitude',
    'longitude',
    'createdAt',
    'updatedAt',
  ]),
  polling_units: new Set([
    'id',
    'code',
    'name',
    'wardId',
    'latitude',
    'longitude',
    'strengthAssessment',
    'status',
    'historicalResults',
    'createdAt',
    'updatedAt',
  ]),
  campaigns: new Set([
    'id',
    'name',
    'slug',
    'stateId',
    'clientPartyCode',
    'trackedParties',
    'isActive',
    'isNational',
    'createdAt',
  ]),
  campaign_memberships: new Set([
    'id',
    'campaignId',
    'role',
    'scopeType',
    'scopeId',
    'isActive',
    'createdAt',
  ]),
  field_reports: new Set([
    'id',
    'campaignId',
    'type',
    'incidentType',
    'incidentSeverity',
    'title',
    'description',
    'wardId',
    'pollingUnitId',
    'latitude',
    'longitude',
    'isUrgent',
    'status',
    'wardComment',
    'handledAt',
    'createdAt',
    'updatedAt',
  ]),
  contests: new Set([
    'id',
    'campaignId',
    'type',
    'slug',
    'label',
    'isDefault',
    'createdAt',
    'updatedAt',
  ]),
  state_assembly_constituencies: new Set([
    'id',
    'name',
    'code',
    'stateId',
    'lgaId',
    'createdAt',
    'updatedAt',
  ]),
  collation_results: new Set([
    'id',
    'campaignId',
    'contestId',
    'level',
    'scopeType',
    'scopeId',
    'registeredVoters',
    'accreditedVoters',
    'ballotPapersIssued',
    'unusedBallotPapers',
    'spoiledBallotPapers',
    'invalidVotes',
    'votesCast',
    'usedBallotPapers',
    'partyResults',
    'status',
    'approvalComment',
    'rejectionReason',
    'submittedAt',
    'approvedAt',
    'createdAt',
    'updatedAt',
  ]),
  collation_action_logs: new Set([
    'id',
    'campaignId',
    'collationResultId',
    'action',
    'fromStatus',
    'toStatus',
    'comment',
    'createdAt',
  ]),
  support_groups: new Set([
    'id',
    'campaignId',
    'name',
    'category',
    'leaderName',
    'memberCount',
    'lgaId',
    'areaOfOperation',
    'latitude',
    'longitude',
    'verificationStatus',
    'createdAt',
  ]),
  volunteers: new Set([
    'id',
    'campaignId',
    'firstName',
    'lastName',
    'wardId',
    'role',
    'performanceScore',
    'isVerified',
    'createdAt',
  ]),
  commitments: new Set([
    'id',
    'campaignId',
    'supportGroupId',
    'title',
    'description',
    'targetValue',
    'currentValue',
    'deadline',
    'status',
    'createdAt',
    'updatedAt',
  ]),
};

export const ALLOWED_TABLES: readonly string[] = Object.keys(ALLOWED_COLUMNS);

/**
 * Function allowlist, not a denylist — anything unlisted (pg_sleep, pg_read_file,
 * dblink…) is rejected. Compared case-insensitively.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'LOWER',
  'UPPER',
  'TRIM',
  'COALESCE',
  'CONCAT',
  'DATE_TRUNC',
  'EXTRACT',
  'NOW',
  'CURRENT_DATE',
  // Added for election arithmetic: turnout/share percentages need rounding and
  // divide-by-zero guards.
  'ROUND',
  'NULLIF',
  'ABS',
  'GREATEST',
  'LEAST',
]);

/**
 * Cast targets. `("partyResults"->>'APC')::int` is the core access pattern for
 * party votes, so casts must be allowed — but only to plain scalar types.
 */
export const ALLOWED_CAST_TYPES: ReadonlySet<string> = new Set([
  'INT',
  'INT2',
  'INT4',
  'INT8',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'NUMERIC',
  'DECIMAL',
  'REAL',
  'FLOAT',
  'FLOAT4',
  'FLOAT8',
  'DOUBLE PRECISION',
  'TEXT',
  'VARCHAR',
  'BOOLEAN',
  'BOOL',
  'DATE',
  'TIMESTAMP',
  'TIMESTAMPTZ',
]);

/**
 * Operators. JSONB access (`->`, `->>`) parses as a binary operator rather than
 * a function, so it needs an explicit entry — but containment operators
 * (`@>`, `#>>`, `||`) stay out until something needs them.
 */
export const ALLOWED_BINARY_OPERATORS: ReadonlySet<string> = new Set([
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  'AND',
  'OR',
  'NOT',
  'IS',
  'IS NOT',
  'LIKE',
  'NOT LIKE',
  'ILIKE',
  'NOT ILIKE',
  'IN',
  'NOT IN',
  'BETWEEN',
  'NOT BETWEEN',
  'EXISTS',
  'NOT EXISTS',
  '->',
  '->>',
]);

/**
 * The only description of the database the model ever receives. It is embedded
 * in the run-sql tool description and repeated in the system prompt, so it has
 * to carry dialect rules, column meanings, and the two join patterns that are
 * impossible to guess (JSONB party votes and the untyped scopeId).
 */
export const SCHEMA_DESCRIPTION = `PostgreSQL. Read-only. One SELECT statement per call.

SYNTAX RULES (queries that break these are rejected before they run):
- Table names are snake_case and unquoted: field_reports, collation_results.
- Column names are camelCase and MUST be double-quoted: "campaignId", "partyResults", "incidentSeverity".
- No SELECT * (COUNT(*) is fine). Name every column you want.
- Max ${MAX_ROWS} rows; a larger or missing LIMIT is rewritten to ${MAX_ROWS}.
- All ids are text cuids, never integers.
- Allowed functions: count, sum, avg, min, max, lower, upper, trim, coalesce,
  concat, date_trunc, extract, now, current_date, round, nullif, abs, greatest, least.

TENANCY: every campaign-scoped table is already filtered by the database to the
requesting user's campaign. Never write a filter to look at "other campaigns" —
none are visible, and asking for them returns nothing.

GEOGRAPHY: read campaigns."isNational". When it is false, this campaign covers
one state (campaigns."stateId") — LGAs, wards, PUs and Assembly seats in that
state only. When it is true, do not scope queries to a single state unless the
question asks for one, and never join through campaigns."stateId" to bound
geography — that is the campaign's base state, not its coverage.

TABLES

states(id, name, code, zone)
  -- code is the 2-letter state code, e.g. 'JI', 'KN', 'LA'. There are 36 states
     plus the FCT.
  -- zone is the geopolitical zone: 'North West', 'North East', 'North Central',
     'South West', 'South East', 'South South'. Group by this to answer regional
     questions ("how are we doing in the North West?").
senatorial_districts(id, name, "stateId")
lgas(id, name, "stateId", "senatorialDistrictId")
wards(id, name, "registrationAreaCode", "lgaId", "constituencyId", latitude, longitude)
  -- "registrationAreaCode" is the INEC RA code, e.g. '17-08-01'
polling_units(id, code, name, "wardId", latitude, longitude, "strengthAssessment", status, "historicalResults")
  -- code is the INEC delimitation code, e.g. '17-08-01-001'
  -- "strengthAssessment": STRONG | SWING | WEAK (manual assessment, often null)
  -- status: ACTIVE | INACTIVE | NEEDS_ATTENTION

campaigns(id, name, slug, "stateId", "clientPartyCode", "trackedParties", "isActive", "isNational", "createdAt")
  -- "clientPartyCode" is OUR party's code. "trackedParties" is a JSON array of
     { code, name, color } describing every party being tracked.
  -- "isNational" true means this campaign covers all 36 states + FCT. When it is
     true, "stateId" is only the campaign's home/base state — DO NOT filter
     geography by it, or you will silently report one state as if it were the
     whole country.
contests(id, "campaignId", type, slug, label, "isDefault", "createdAt", "updatedAt")
  -- One row per race. type: GOVERNORSHIP | ASSEMBLY. slug: governorship | assembly.
     This campaign tracks both. Join collation_results."contestId" = contests.id
     and label the race. NEVER add governorship votes to Assembly votes.
state_assembly_constituencies(id, name, code, "stateId", "lgaId", "createdAt", "updatedAt")
  -- Gombe State House of Assembly seats (24). Wards map onto a seat via
     wards."constituencyId" when present. Join on id for CONSTITUENCY results.
campaign_memberships(id, "campaignId", role, "scopeType", "scopeId", "isActive", "createdAt")
  -- role: CANDIDATE | CAMPAIGN_DIRECTOR | DATA_ANALYST | MEDIA_TEAM |
     POLLING_AGENT | VOLUNTEER | VOLUNTEER_COORDINATOR | POLLING_AGENT_COORDINATOR |
     SUPPORT_GROUP_LEADER | WARD_RA_OFFICER | LGA_COLLATION_OFFICER |
     STATE_COLLATION_OFFICER | NATIONAL_COLLATION_OFFICER (plus deprecated
     STATE_COORDINATOR, LGA_COORDINATOR, WARD_COORDINATOR, POLLING_UNIT_OFFICER)
  -- "scopeType": CAMPAIGN | STATE | SENATORIAL_DISTRICT | LGA | WARD | POLLING_UNIT | NATIONAL
  -- "scopeId" holds the id of that scope's row (an lgas.id when scopeType='LGA', etc.)

field_reports(id, "campaignId", type, "incidentType", "incidentSeverity", title,
              description, "wardId", "pollingUnitId", latitude, longitude,
              "isUrgent", status, "wardComment", "handledAt", "createdAt", "updatedAt")
  -- Incidents live here. type: INCIDENT | SECURITY_CONCERN | OPPOSITION_ACTIVITY |
     COMMUNITY_REQUEST | CAMPAIGN_PROGRESS | DAILY_SITREP.
     Real incidents are type IN ('INCIDENT','SECURITY_CONCERN').
  -- "incidentType": VOTER_INTIMIDATION | BALLOT_SNATCHING | BALLOT_STUFFING |
     VOTE_BUYING | VIOLENCE_THUGGERY | MATERIALS_SHORTAGE | LATE_OR_FAILED_OPENING |
     BVAS_MALFUNCTION | UNAUTHORIZED_PERSONNEL | OVERVOTING | OPPOSITION_DISRUPTION | OTHERS
  -- "incidentSeverity": LOW | MEDIUM | HIGH | CRITICAL   status: OPEN | ESCALATED | RESOLVED
  -- Unresolved means status <> 'RESOLVED'.
  -- Geography is EITHER "wardId" OR "pollingUnitId" (both nullable, there is no
     lgaId). To group incidents by LGA, join through whichever is set:
       LEFT JOIN wards w ON w.id = fr."wardId"
       LEFT JOIN polling_units pu ON pu.id = fr."pollingUnitId"
       LEFT JOIN wards pw ON pw.id = pu."wardId"
     then group by coalesce(w."lgaId", pw."lgaId").

collation_results(id, "campaignId", "contestId", level, "scopeType", "scopeId",
                  "registeredVoters", "accreditedVoters", "ballotPapersIssued",
                  "unusedBallotPapers", "spoiledBallotPapers", "invalidVotes",
                  "votesCast", "usedBallotPapers", "partyResults", status,
                  "approvalComment", "rejectionReason", "submittedAt",
                  "approvedAt", "createdAt", "updatedAt")
  -- One row per (campaign, contest, level, scope). Always filter or join
     "contestId" so governorship and Assembly figures stay separate.
     level: POLLING_UNIT | WARD | LGA | CONSTITUENCY | STATE | NATIONAL.
     Higher levels are rollups of approved children, so DO NOT sum PU rows and
     LGA rows together — pick one level.
  -- This is a NATIONWIDE deployment: roughly 176,000 polling units, 8,800 wards,
     774 LGAs, 37 states. Always aggregate at the coarsest level that answers the
     question. For a national picture read level='STATE' (37 rows) or
     level='NATIONAL' (1 row); only drop to WARD or POLLING_UNIT once you have
     narrowed to a specific LGA or ward, otherwise the row cap will truncate the
     answer and mislead.
  -- status: DRAFT | SUBMITTED | APPROVED | REJECTED. "Reported" usually means
     status IN ('SUBMITTED','APPROVED','REJECTED'); "final" means 'APPROVED'.
  -- EC8A figures (all nullable integers, taken from the paper result sheet):
       "registeredVoters"    Number of voters on the register
       "accreditedVoters"    Number accredited on election day
       "ballotPapersIssued"  Ballot papers issued to the polling unit
       "unusedBallotPapers"  Unused ballot papers
       "spoiledBallotPapers" Spoiled ballot papers
       "invalidVotes"        Rejected ballots
       "votesCast"           Total VALID votes (equals the sum of party scores)
       "usedBallotPapers"    spoiled + rejected + valid
  -- Turnout is not stored. Compute it, guarding against divide-by-zero:
       round(100.0 * "accreditedVoters" / nullif("registeredVoters", 0), 1)

  -- "partyResults" is JSONB mapping party code to votes, e.g. {"APC": 159, "PDP": 88}.
     Read a party's votes with:  ("partyResults"->>'APC')::int
     Our party's code is campaigns."clientPartyCode"; the full tracked list is
     campaigns."trackedParties".

  -- "scopeId" is a plain text id with NO foreign key. What it points at depends
     on level, so always constrain level when joining:
       level='POLLING_UNIT' -> polling_units.id
       level='WARD'         -> wards.id
       level='LGA'          -> lgas.id
       level='CONSTITUENCY' -> state_assembly_constituencies.id
       level='STATE'        -> states.id
       level='NATIONAL'     -> a fixed sentinel, not a geography row; do not join it
     e.g.  JOIN lgas l ON l.id = cr."scopeId" AND cr.level = 'LGA'
     For a state-by-state view:
           JOIN states s ON s.id = cr."scopeId" AND cr.level = 'STATE'
     and group by s.zone for a regional view.

collation_action_logs(id, "campaignId", "collationResultId", action, "fromStatus",
                      "toStatus", comment, "createdAt")
  -- Append-only submit/approve/reject trail. action: SUBMITTED | APPROVED | REJECTED.
     Best source for timing questions (how fast results are coming in, approval lag).

support_groups(id, "campaignId", name, category, "leaderName", "memberCount",
               "lgaId", "areaOfOperation", latitude, longitude, "verificationStatus", "createdAt")
  -- category: YOUTH | WOMEN | FARMERS | PROFESSIONALS | STUDENTS | RELIGIOUS | COMMUNITY
  -- "verificationStatus": PENDING | VERIFIED | ACTIVE | REJECTED
volunteers(id, "campaignId", "firstName", "lastName", "wardId", role,
           "performanceScore", "isVerified", "createdAt")
commitments(id, "campaignId", "supportGroupId", title, description, "targetValue",
            "currentValue", deadline, status, "createdAt", "updatedAt")
  -- status: DRAFT | ACTIVE | COMPLETED | CANCELLED

NOT AVAILABLE TO YOU, FOR ANYONE, REGARDLESS OF WHO IS ASKING: user accounts and
passwords, phone numbers, email addresses, audit logs, notifications, device
tokens, and the identity of who reported, submitted, or approved any record.
Those columns and tables are not in the schema above and querying them fails.
If asked for them, say plainly that you cannot access personal or account data.`;
