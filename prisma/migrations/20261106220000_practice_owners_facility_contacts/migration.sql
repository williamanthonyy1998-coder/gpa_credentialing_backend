-- Additive Phase 3 directory foundation.
-- Backup PostgreSQL before applying. Does not drop tables or delete rows.

-- Practice banking (practice-level; org banking retained)
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankAccountTitle" TEXT;
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankAccountNumber" TEXT;
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankRoutingNumber" TEXT;
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankContactName" TEXT;
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankContactPhone" TEXT;
ALTER TABLE "Practice" ADD COLUMN IF NOT EXISTS "bankContactEmail" TEXT;

-- Contact kind enum
DO $$ BEGIN
  CREATE TYPE "ContactKind" AS ENUM ('PERSON', 'ORGANIZATION');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "PracticeOwner" (
  "id" TEXT NOT NULL,
  "practiceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownershipPercent" DECIMAL(5,2) NOT NULL,
  "ssn" TEXT,
  "dateOfBirth" TIMESTAMP(3),
  "ownershipDate" TIMESTAMP(3),
  "placeOfBirth" TEXT,
  "address" JSONB,
  "phone" TEXT,
  "fax" TEXT,
  "email" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PracticeOwner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PracticeOwner_practiceId_idx" ON "PracticeOwner"("practiceId");

DO $$ BEGIN
  ALTER TABLE "PracticeOwner" ADD CONSTRAINT "PracticeOwner_practiceId_fkey"
    FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "FacilityContact" (
  "id" TEXT NOT NULL,
  "facilityId" TEXT NOT NULL,
  "kind" "ContactKind" NOT NULL DEFAULT 'PERSON',
  "name" TEXT,
  "title" TEXT,
  "organizationName" TEXT,
  "email" TEXT,
  "phone" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FacilityContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FacilityContact_facilityId_kind_idx" ON "FacilityContact"("facilityId", "kind");

DO $$ BEGIN
  ALTER TABLE "FacilityContact" ADD CONSTRAINT "FacilityContact_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
