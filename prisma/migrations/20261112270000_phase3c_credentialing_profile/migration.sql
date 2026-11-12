-- Phase 3C: Unified credentialing profile readiness, gaps (Task fingerprint), profile review.
-- Additive only. Does not rewrite historical license/history/document evidence.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProfileReviewStatus') THEN
    CREATE TYPE "ProfileReviewStatus" AS ENUM (
      'NOT_STARTED',
      'IN_PROGRESS',
      'CORRECTIONS_REQUESTED',
      'RESUBMITTED',
      'COMPLETED'
    );
  END IF;
END $$;

ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "fingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "relatedType" TEXT,
  ADD COLUMN IF NOT EXISTS "relatedId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Task_tenantId_fingerprint_key"
  ON "Task"("tenantId", "fingerprint");

CREATE INDEX IF NOT EXISTS "Task_tenantId_source_status_idx"
  ON "Task"("tenantId", "source", "status");

CREATE INDEX IF NOT EXISTS "Task_providerId_source_status_idx"
  ON "Task"("providerId", "source", "status");

CREATE TABLE IF NOT EXISTS "ProviderProfileReview" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "status" "ProfileReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "startedAt" TIMESTAMP(3),
  "startedById" TEXT,
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  "correctionsRequestedAt" TIMESTAMP(3),
  "resubmittedAt" TIMESTAMP(3),
  "clientVisibleNotes" TEXT,
  "internalNotes" TEXT,
  "readinessSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderProfileReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProviderProfileReview_tenantId_providerId_status_idx"
  ON "ProviderProfileReview"("tenantId", "providerId", "status");

CREATE INDEX IF NOT EXISTS "ProviderProfileReview_tenantId_status_idx"
  ON "ProviderProfileReview"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "ProviderProfileReview_providerId_updatedAt_idx"
  ON "ProviderProfileReview"("providerId", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProviderProfileReview_tenantId_fkey'
  ) THEN
    ALTER TABLE "ProviderProfileReview"
      ADD CONSTRAINT "ProviderProfileReview_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ProviderProfileReview_providerId_fkey'
  ) THEN
    ALTER TABLE "ProviderProfileReview"
      ADD CONSTRAINT "ProviderProfileReview_providerId_fkey"
      FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
