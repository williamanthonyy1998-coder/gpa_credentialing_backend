-- Phase 4A: Enrollment lifecycle foundation (additive). Preserves existing enrollment rows.

DO $$ BEGIN ALTER TYPE "EnrollmentStatus" ADD VALUE 'ACKNOWLEDGED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "EnrollmentStatus" ADD VALUE 'EFFECTIVE'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "EnrollmentStatus" ADD VALUE 'TERMINATED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "EnrollmentStatus" ADD VALUE 'CLOSED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "EnrollmentApplication"
  ADD COLUMN IF NOT EXISTS "billingEntityId" TEXT,
  ADD COLUMN IF NOT EXISTS "enrollmentType" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
  ADD COLUMN IF NOT EXISTS "preparedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "terminatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "terminationReason" TEXT,
  ADD COLUMN IF NOT EXISTS "submissionEvidenceDocumentId" TEXT,
  ADD COLUMN IF NOT EXISTS "acknowledgmentEvidenceDocumentId" TEXT,
  ADD COLUMN IF NOT EXISTS "decisionEvidenceDocumentId" TEXT,
  ADD COLUMN IF NOT EXISTS "internalNotes" TEXT;

ALTER TABLE "StatusHistory"
  ADD COLUMN IF NOT EXISTS "eventType" TEXT,
  ADD COLUMN IF NOT EXISTS "actorRole" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE INDEX IF NOT EXISTS "EnrollmentApplication_tenantId_enrollmentType_status_idx"
  ON "EnrollmentApplication"("tenantId", "enrollmentType", "status");

CREATE INDEX IF NOT EXISTS "EnrollmentApplication_billingEntityId_idx"
  ON "EnrollmentApplication"("billingEntityId");

CREATE INDEX IF NOT EXISTS "EnrollmentApplication_tenantId_providerId_payerPlanId_facilityId_idx"
  ON "EnrollmentApplication"("tenantId", "providerId", "payerPlanId", "facilityId");

CREATE INDEX IF NOT EXISTS "StatusHistory_eventType_createdAt_idx"
  ON "StatusHistory"("eventType", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentApplication_billingEntityId_fkey'
  ) THEN
    ALTER TABLE "EnrollmentApplication"
      ADD CONSTRAINT "EnrollmentApplication_billingEntityId_fkey"
      FOREIGN KEY ("billingEntityId") REFERENCES "BillingEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
