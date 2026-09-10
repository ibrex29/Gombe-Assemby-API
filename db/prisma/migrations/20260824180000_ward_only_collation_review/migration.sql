-- Ward-only approval: reviewers can comment without changing status.
ALTER TYPE "CollationActionType" ADD VALUE IF NOT EXISTS 'COMMENTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RESULT_COMMENTED';
