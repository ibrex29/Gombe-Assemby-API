-- Social listening scaffold: sources, captured posts, and rolled-up sentiment.
-- Analysis columns on social_posts stay NULL until the analyze worker runs, so
-- ingestion works before any model is configured.

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'X', 'TIKTOK', 'WHATSAPP', 'OTHER');

-- CreateEnum
CREATE TYPE "SocialSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "social_sources" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_posts" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "authorHandle" TEXT,
    "text" TEXT NOT NULL,
    "lang" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "permalink" TEXT,
    "mediaUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "raw" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentiment" "SocialSentiment",
    "sentimentScore" DOUBLE PRECISION,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entities" JSONB,
    "stateId" TEXT,
    "lgaId" TEXT,
    "relevance" DOUBLE PRECISION,
    "analyzedAt" TIMESTAMP(3),
    "modelMeta" JSONB,

    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_snapshots" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contestId" TEXT,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "positiveCount" INTEGER NOT NULL DEFAULT 0,
    "neutralCount" INTEGER NOT NULL DEFAULT 0,
    "negativeCount" INTEGER NOT NULL DEFAULT 0,
    "mixedCount" INTEGER NOT NULL DEFAULT 0,
    "unknownCount" INTEGER NOT NULL DEFAULT 0,
    "avgScore" DOUBLE PRECISION,
    "topTopics" JSONB,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sentiment_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_sources_campaignId_platform_handle_key" ON "social_sources"("campaignId", "platform", "handle");
CREATE INDEX "social_sources_campaignId_isActive_idx" ON "social_sources"("campaignId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "social_posts_campaignId_platform_externalId_key" ON "social_posts"("campaignId", "platform", "externalId");
CREATE INDEX "social_posts_campaignId_postedAt_idx" ON "social_posts"("campaignId", "postedAt");
CREATE INDEX "social_posts_campaignId_sentiment_postedAt_idx" ON "social_posts"("campaignId", "sentiment", "postedAt");
CREATE INDEX "social_posts_sourceId_postedAt_idx" ON "social_posts"("sourceId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sentiment_snapshots_campaignId_scopeType_scopeId_windowStar_key" ON "sentiment_snapshots"("campaignId", "scopeType", "scopeId", "windowStart");
CREATE INDEX "sentiment_snapshots_campaignId_scopeType_scopeId_windowEnd_idx" ON "sentiment_snapshots"("campaignId", "scopeType", "scopeId", "windowEnd");

-- AddForeignKey
ALTER TABLE "social_sources" ADD CONSTRAINT "social_sources_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "social_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_lgaId_fkey" FOREIGN KEY ("lgaId") REFERENCES "lgas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sentiment_snapshots" ADD CONSTRAINT "sentiment_snapshots_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
