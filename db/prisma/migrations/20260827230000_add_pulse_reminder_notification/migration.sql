-- Enum values only. ALTER TYPE ADD VALUE cannot share a transaction with
-- statements that use the new value, so nothing else belongs in this migration.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PULSE_REMINDER';
