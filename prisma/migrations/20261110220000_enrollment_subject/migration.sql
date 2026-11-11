-- Additive enrollment subject / application name.
-- Safe nullable column. No row deletes. No resets.

ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "subject" TEXT;

CREATE INDEX IF NOT EXISTS "EnrollmentApplication_facilityId_status_idx"
  ON "EnrollmentApplication"("facilityId", "status");
