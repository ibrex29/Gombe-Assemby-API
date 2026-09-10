-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CampaignRole" AS ENUM ('CANDIDATE', 'CAMPAIGN_DIRECTOR', 'STATE_COORDINATOR', 'LGA_COORDINATOR', 'WARD_COORDINATOR', 'SUPPORT_GROUP_LEADER', 'VOLUNTEER_COORDINATOR', 'POLLING_AGENT_COORDINATOR', 'DATA_ANALYST', 'MEDIA_TEAM', 'POLLING_AGENT', 'VOLUNTEER', 'POLLING_UNIT_OFFICER', 'WARD_RA_OFFICER', 'LGA_COLLATION_OFFICER', 'STATE_COLLATION_OFFICER', 'NATIONAL_COLLATION_OFFICER');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('CAMPAIGN', 'STATE', 'SENATORIAL_DISTRICT', 'LGA', 'WARD', 'POLLING_UNIT', 'NATIONAL');

-- CreateEnum
CREATE TYPE "CollationLevel" AS ENUM ('POLLING_UNIT', 'WARD', 'LGA', 'STATE', 'NATIONAL');

-- CreateEnum
CREATE TYPE "CollationResultStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CollationActionType" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SupportGroupCategory" AS ENUM ('YOUTH', 'WOMEN', 'FARMERS', 'PROFESSIONALS', 'STUDENTS', 'RELIGIOUS', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "FieldReportType" AS ENUM ('SECURITY_CONCERN', 'COMMUNITY_REQUEST', 'OPPOSITION_ACTIVITY', 'CAMPAIGN_PROGRESS', 'DAILY_SITREP', 'INCIDENT');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('VOTER_INTIMIDATION', 'BALLOT_SNATCHING', 'BALLOT_STUFFING', 'VOTE_BUYING', 'VIOLENCE_THUGGERY', 'MATERIALS_SHORTAGE', 'LATE_OR_FAILED_OPENING', 'BVAS_MALFUNCTION', 'UNAUTHORIZED_PERSONNEL', 'OVERVOTING', 'OPPOSITION_DISRUPTION', 'OTHERS');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FieldReportStatus" AS ENUM ('OPEN', 'ESCALATED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PollingUnitStrength" AS ENUM ('STRONG', 'SWING', 'WEAK');

-- CreateEnum
CREATE TYPE "PollingUnitStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "SituationStatus" AS ENUM ('OPEN', 'REPORTING', 'CLOSED', 'INCIDENT');

-- CreateEnum
CREATE TYPE "CommitmentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VolunteerTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('RESULT_SUBMITTED', 'RESULT_APPROVED', 'RESULT_RETURNED', 'WARD_RETURNED_BY_LGA', 'WARD_FORWARDED_TO_LGA', 'INCIDENT_REPORTED', 'INCIDENT_RESOLVED', 'INCIDENT_ESCALATED', 'SITUATION_UPDATE');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "otherNames" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "isNational" BOOLEAN NOT NULL DEFAULT false,
    "clientPartyCode" TEXT,
    "trackedParties" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "role" "CampaignRole" NOT NULL,
    "scopeType" "ScopeType",
    "scopeId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "role" "CampaignRole" NOT NULL,
    "scopeType" "ScopeType",
    "scopeId" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "states" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "zone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "senatorial_districts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "senatorial_districts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lgas" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "senatorialDistrictId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lgas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registrationAreaCode" TEXT,
    "lgaId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polling_units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "strengthAssessment" "PollingUnitStrength",
    "status" "PollingUnitStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedAgentId" TEXT,
    "historicalResults" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polling_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_groups" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "SupportGroupCategory" NOT NULL,
    "leaderName" TEXT NOT NULL,
    "leaderPhone" TEXT NOT NULL,
    "leaderEmail" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "lgaId" TEXT,
    "areaOfOperation" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "coordinatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commitments" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "supportGroupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targetValue" INTEGER NOT NULL,
    "currentValue" INTEGER NOT NULL DEFAULT 0,
    "deadline" TIMESTAMP(3) NOT NULL,
    "status" "CommitmentStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commitment_progress" (
    "id" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "notes" TEXT,
    "evidenceUrl" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "submittedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commitment_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteers" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "email" TEXT,
    "wardId" TEXT,
    "role" TEXT,
    "coordinatorId" TEXT,
    "performanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volunteers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_assignments" (
    "id" TEXT NOT NULL,
    "volunteerId" TEXT NOT NULL,
    "wardId" TEXT,
    "role" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volunteer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_tasks" (
    "id" TEXT NOT NULL,
    "volunteerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "VolunteerTaskStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volunteer_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_reports" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "type" "FieldReportType" NOT NULL,
    "incidentType" "IncidentType",
    "incidentSeverity" "IncidentSeverity",
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "wardId" TEXT,
    "pollingUnitId" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "photoUrls" TEXT[],
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "status" "FieldReportStatus" NOT NULL DEFAULT 'OPEN',
    "wardComment" TEXT,
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "situation_updates" (
    "id" TEXT NOT NULL,
    "pollingUnitId" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "status" "SituationStatus" NOT NULL,
    "notes" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isUrgent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "situation_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collation_results" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "level" "CollationLevel" NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "registeredVoters" INTEGER,
    "accreditedVoters" INTEGER,
    "ballotPapersIssued" INTEGER,
    "unusedBallotPapers" INTEGER,
    "spoiledBallotPapers" INTEGER,
    "invalidVotes" INTEGER,
    "votesCast" INTEGER,
    "usedBallotPapers" INTEGER,
    "partyResults" JSONB,
    "ec8aPhotoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalComment" TEXT,
    "status" "CollationResultStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "flaggedPollingUnitIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flaggedWardIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ocrVerification" JSONB,
    "ocrVerifiedAt" TIMESTAMP(3),
    "parentResultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collation_action_logs" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "collationResultId" TEXT NOT NULL,
    "action" "CollationActionType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "fromStatus" "CollationResultStatus",
    "toStatus" "CollationResultStatus" NOT NULL,
    "comment" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collation_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "campaignId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_phoneNumber_idx" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_token_idx" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "activity_logs_userId_idx" ON "activity_logs"("userId");

-- CreateIndex
CREATE INDEX "activity_logs_campaignId_idx" ON "activity_logs"("campaignId");

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_slug_key" ON "campaigns"("slug");

-- CreateIndex
CREATE INDEX "campaigns_stateId_idx" ON "campaigns"("stateId");

-- CreateIndex
CREATE INDEX "campaign_memberships_campaignId_idx" ON "campaign_memberships"("campaignId");

-- CreateIndex
CREATE INDEX "campaign_memberships_role_idx" ON "campaign_memberships"("role");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_memberships_userId_campaignId_key" ON "campaign_memberships"("userId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_invitations_token_key" ON "campaign_invitations"("token");

-- CreateIndex
CREATE INDEX "campaign_invitations_token_idx" ON "campaign_invitations"("token");

-- CreateIndex
CREATE INDEX "campaign_invitations_email_idx" ON "campaign_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "states_name_key" ON "states"("name");

-- CreateIndex
CREATE UNIQUE INDEX "states_code_key" ON "states"("code");

-- CreateIndex
CREATE INDEX "states_zone_idx" ON "states"("zone");

-- CreateIndex
CREATE INDEX "senatorial_districts_stateId_idx" ON "senatorial_districts"("stateId");

-- CreateIndex
CREATE UNIQUE INDEX "senatorial_districts_name_stateId_key" ON "senatorial_districts"("name", "stateId");

-- CreateIndex
CREATE INDEX "lgas_stateId_idx" ON "lgas"("stateId");

-- CreateIndex
CREATE INDEX "lgas_senatorialDistrictId_idx" ON "lgas"("senatorialDistrictId");

-- CreateIndex
CREATE UNIQUE INDEX "lgas_name_stateId_key" ON "lgas"("name", "stateId");

-- CreateIndex
CREATE INDEX "wards_lgaId_idx" ON "wards"("lgaId");

-- CreateIndex
CREATE UNIQUE INDEX "wards_name_lgaId_key" ON "wards"("name", "lgaId");

-- CreateIndex
CREATE UNIQUE INDEX "polling_units_code_key" ON "polling_units"("code");

-- CreateIndex
CREATE INDEX "polling_units_wardId_idx" ON "polling_units"("wardId");

-- CreateIndex
CREATE INDEX "polling_units_status_idx" ON "polling_units"("status");

-- CreateIndex
CREATE INDEX "support_groups_campaignId_idx" ON "support_groups"("campaignId");

-- CreateIndex
CREATE INDEX "support_groups_category_idx" ON "support_groups"("category");

-- CreateIndex
CREATE INDEX "support_groups_verificationStatus_idx" ON "support_groups"("verificationStatus");

-- CreateIndex
CREATE INDEX "commitments_campaignId_idx" ON "commitments"("campaignId");

-- CreateIndex
CREATE INDEX "commitments_supportGroupId_idx" ON "commitments"("supportGroupId");

-- CreateIndex
CREATE INDEX "commitment_progress_commitmentId_idx" ON "commitment_progress"("commitmentId");

-- CreateIndex
CREATE INDEX "volunteers_campaignId_idx" ON "volunteers"("campaignId");

-- CreateIndex
CREATE INDEX "volunteers_wardId_idx" ON "volunteers"("wardId");

-- CreateIndex
CREATE INDEX "volunteer_assignments_volunteerId_idx" ON "volunteer_assignments"("volunteerId");

-- CreateIndex
CREATE INDEX "volunteer_tasks_volunteerId_idx" ON "volunteer_tasks"("volunteerId");

-- CreateIndex
CREATE INDEX "volunteer_tasks_status_idx" ON "volunteer_tasks"("status");

-- CreateIndex
CREATE INDEX "field_reports_campaignId_idx" ON "field_reports"("campaignId");

-- CreateIndex
CREATE INDEX "field_reports_type_idx" ON "field_reports"("type");

-- CreateIndex
CREATE INDEX "field_reports_incidentType_idx" ON "field_reports"("incidentType");

-- CreateIndex
CREATE INDEX "field_reports_incidentSeverity_idx" ON "field_reports"("incidentSeverity");

-- CreateIndex
CREATE INDEX "field_reports_status_idx" ON "field_reports"("status");

-- CreateIndex
CREATE INDEX "field_reports_wardId_idx" ON "field_reports"("wardId");

-- CreateIndex
CREATE INDEX "field_reports_createdAt_idx" ON "field_reports"("createdAt");

-- CreateIndex
CREATE INDEX "situation_updates_pollingUnitId_idx" ON "situation_updates"("pollingUnitId");

-- CreateIndex
CREATE INDEX "situation_updates_status_idx" ON "situation_updates"("status");

-- CreateIndex
CREATE INDEX "situation_updates_createdAt_idx" ON "situation_updates"("createdAt");

-- CreateIndex
CREATE INDEX "collation_results_campaignId_level_status_idx" ON "collation_results"("campaignId", "level", "status");

-- CreateIndex
CREATE INDEX "collation_results_scopeType_scopeId_idx" ON "collation_results"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "collation_results_parentResultId_idx" ON "collation_results"("parentResultId");

-- CreateIndex
CREATE UNIQUE INDEX "collation_results_campaignId_level_scopeType_scopeId_key" ON "collation_results"("campaignId", "level", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "collation_action_logs_collationResultId_createdAt_idx" ON "collation_action_logs"("collationResultId", "createdAt");

-- CreateIndex
CREATE INDEX "collation_action_logs_campaignId_createdAt_idx" ON "collation_action_logs"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "collation_action_logs_actorId_idx" ON "collation_action_logs"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_userId_isActive_idx" ON "device_tokens"("userId", "isActive");

-- CreateIndex
CREATE INDEX "notifications_recipientUserId_createdAt_idx" ON "notifications"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_recipientUserId_readAt_idx" ON "notifications"("recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_campaignId_createdAt_idx" ON "notifications"("campaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications"("campaignId", "type", "entityId", "recipientUserId", "sourceEventId");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_memberships" ADD CONSTRAINT "campaign_memberships_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "senatorial_districts" ADD CONSTRAINT "senatorial_districts_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lgas" ADD CONSTRAINT "lgas_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lgas" ADD CONSTRAINT "lgas_senatorialDistrictId_fkey" FOREIGN KEY ("senatorialDistrictId") REFERENCES "senatorial_districts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "lgas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polling_units" ADD CONSTRAINT "polling_units_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "wards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_groups" ADD CONSTRAINT "support_groups_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_groups" ADD CONSTRAINT "support_groups_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "lgas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_supportGroupId_fkey" FOREIGN KEY ("supportGroupId") REFERENCES "support_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitment_progress" ADD CONSTRAINT "commitment_progress_commitmentId_fkey" FOREIGN KEY ("commitmentId") REFERENCES "commitments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteers" ADD CONSTRAINT "volunteers_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteers" ADD CONSTRAINT "volunteers_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_assignments" ADD CONSTRAINT "volunteer_assignments_volunteerId_fkey" FOREIGN KEY ("volunteerId") REFERENCES "volunteers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_tasks" ADD CONSTRAINT "volunteer_tasks_volunteerId_fkey" FOREIGN KEY ("volunteerId") REFERENCES "volunteers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_reports" ADD CONSTRAINT "field_reports_pollingUnitId_fkey" FOREIGN KEY ("pollingUnitId") REFERENCES "polling_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_updates" ADD CONSTRAINT "situation_updates_pollingUnitId_fkey" FOREIGN KEY ("pollingUnitId") REFERENCES "polling_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_updates" ADD CONSTRAINT "situation_updates_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_results" ADD CONSTRAINT "collation_results_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_results" ADD CONSTRAINT "collation_results_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_results" ADD CONSTRAINT "collation_results_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_results" ADD CONSTRAINT "collation_results_parentResultId_fkey" FOREIGN KEY ("parentResultId") REFERENCES "collation_results"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_action_logs" ADD CONSTRAINT "collation_action_logs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_action_logs" ADD CONSTRAINT "collation_action_logs_collationResultId_fkey" FOREIGN KEY ("collationResultId") REFERENCES "collation_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collation_action_logs" ADD CONSTRAINT "collation_action_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
