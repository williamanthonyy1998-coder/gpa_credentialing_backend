-- Additive enrollment highlight/alert flag.
-- Safe nullable-default column. No row deletes. No resets.
-- Highlighting does not change enrollment status.

ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "highlighted" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "EnrollmentApplication_highlighted_idx"
  ON "EnrollmentApplication"("highlighted");
