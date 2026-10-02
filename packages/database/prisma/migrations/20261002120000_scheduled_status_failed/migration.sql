-- Add a terminal "failed" state for scheduled broadcasts whose fire gave up
-- (deterministic error, e.g. the template gained an unfilled placeholder).
-- Kept in its own migration: Postgres forbids using a new enum value in the
-- same transaction that adds it.
ALTER TYPE "ScheduledStatus" ADD VALUE IF NOT EXISTS 'failed';
