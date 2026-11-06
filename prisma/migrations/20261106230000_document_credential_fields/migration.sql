-- Additive document/credential fields. Backup before apply. No row deletes.

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "ignored" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "reportingRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "warningDays" INTEGER;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "createdById" TEXT;

CREATE INDEX IF NOT EXISTS "Document_category_status_idx" ON "Document"("category", "status");
CREATE INDEX IF NOT EXISTS "Document_facilityId_category_idx" ON "Document"("facilityId", "category");

DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
