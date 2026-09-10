-- AI assistant chat threads and messages (server-side history per user + campaign).

CREATE TYPE "AiChatMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "ai_chat_threads" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chat_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_chat_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "AiChatMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "replyToId" TEXT,
    "meta" JSONB,
    "spoken" TEXT,
    "attachments" JSONB,
    "charts" JSONB,
    "contacts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_chat_threads_campaignId_userId_updatedAt_idx" ON "ai_chat_threads"("campaignId", "userId", "updatedAt");

CREATE INDEX "ai_chat_messages_threadId_createdAt_idx" ON "ai_chat_messages"("threadId", "createdAt");

ALTER TABLE "ai_chat_threads" ADD CONSTRAINT "ai_chat_threads_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_chat_threads" ADD CONSTRAINT "ai_chat_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ai_chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ai_chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
