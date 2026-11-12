-- Phase 3B: License lifecycle, verification, renewal linkage (additive).

ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "suspended" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'NOT_SUBMITTED';
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "verifiedById" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "reviewerNotes" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "correctionRequest" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "documentId" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "renewedFromId" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "sourceIntakeId" TEXT;

-- Backfill tenantId from TenantProvider when uniquely determinable.
UPDATE "License" l
SET "tenantId" = tp."tenantId"
FROM "TenantProvider" tp
WHERE l."providerId" = tp."providerId"
  AND l."tenantId" IS NULL
  AND (
    SELECT COUNT(*) FROM "TenantProvider" x WHERE x."providerId" = l."providerId"
  ) = 1;

-- Map legacy DocumentStatus into verificationStatus where sensible (non-destructive).
UPDATE "License"
SET "verificationStatus" = 'VERIFIED'
WHERE "status" = 'VERIFIED' AND "verificationStatus" = 'NOT_SUBMITTED';

UPDATE "License"
SET "verificationStatus" = 'PENDING_REVIEW'
WHERE "status" = 'UNDER_REVIEW' AND "verificationStatus" = 'NOT_SUBMITTED';

UPDATE "License"
SET "verificationStatus" = 'REJECTED'
WHERE "status" = 'REJECTED' AND "verificationStatus" = 'NOT_SUBMITTED';

CREATE TABLE IF NOT EXISTS "LicenseEvent" (
  "id" TEXT NOT NULL,
  "licenseId" TEXT NOT NULL,
  "tenantId" TEXT,
  "action" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "actorId" TEXT,
  "reason" TEXT,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LicenseEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "License_tenantId_providerId_idx" ON "License"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "License_tenantId_verificationStatus_idx" ON "License"("tenantId", "verificationStatus");
CREATE INDEX IF NOT EXISTS "License_tenantId_expiresAt_idx" ON "License"("tenantId", "expiresAt");
CREATE INDEX IF NOT EXISTS "License_renewedFromId_idx" ON "License"("renewedFromId");
CREATE INDEX IF NOT EXISTS "License_archived_suspended_idx" ON "License"("archived", "suspended");
CREATE INDEX IF NOT EXISTS "LicenseEvent_licenseId_createdAt_idx" ON "LicenseEvent"("licenseId", "createdAt");
CREATE INDEX IF NOT EXISTS "LicenseEvent_tenantId_createdAt_idx" ON "LicenseEvent"("tenantId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "License" ADD CONSTRAINT "License_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "License" ADD CONSTRAINT "License_renewedFromId_fkey"
    FOREIGN KEY ("renewedFromId") REFERENCES "License"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "LicenseEvent" ADD CONSTRAINT "LicenseEvent_licenseId_fkey"
    FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
