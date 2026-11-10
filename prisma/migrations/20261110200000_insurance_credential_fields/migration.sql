-- Additive insurance credential fields and many-to-many associations.
-- Safe defaults/nullables. No row deletes. No resets.

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "policyNumber" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "perOccurrence" DECIMAL(14,2);
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "aggregate" DECIMAL(14,2);
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "insuranceCompany" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "namedInsured" TEXT;

CREATE TABLE IF NOT EXISTS "DocumentFacility" (
  "documentId" TEXT NOT NULL,
  "facilityId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentFacility_pkey" PRIMARY KEY ("documentId", "facilityId")
);

CREATE TABLE IF NOT EXISTS "DocumentProvider" (
  "documentId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentProvider_pkey" PRIMARY KEY ("documentId", "providerId")
);

CREATE INDEX IF NOT EXISTS "DocumentFacility_facilityId_idx" ON "DocumentFacility"("facilityId");
CREATE INDEX IF NOT EXISTS "DocumentProvider_providerId_idx" ON "DocumentProvider"("providerId");

DO $$ BEGIN
  ALTER TABLE "DocumentFacility" ADD CONSTRAINT "DocumentFacility_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocumentFacility" ADD CONSTRAINT "DocumentFacility_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocumentProvider" ADD CONSTRAINT "DocumentProvider_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocumentProvider" ADD CONSTRAINT "DocumentProvider_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Backfill primary facility link into junction for existing facility-scoped credentials.
INSERT INTO "DocumentFacility" ("documentId", "facilityId", "createdAt")
SELECT d."id", d."facilityId", CURRENT_TIMESTAMP
FROM "Document" d
WHERE d."facilityId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Backfill primary provider link into junction when present.
INSERT INTO "DocumentProvider" ("documentId", "providerId", "createdAt")
SELECT d."id", d."providerId", CURRENT_TIMESTAMP
FROM "Document" d
WHERE d."providerId" IS NOT NULL
ON CONFLICT DO NOTHING;
