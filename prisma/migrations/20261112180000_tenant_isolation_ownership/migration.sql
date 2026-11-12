-- Phase 0B: tenant ownership columns + TenantProvider (additive).
-- Deterministic backfill only where Organization.tenantId (or chain) is known.
-- Unmapped rows remain NULL and are denied for tenant-scoped access.

CREATE TABLE IF NOT EXISTS "TenantProvider" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantProvider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantProvider_tenantId_providerId_key" ON "TenantProvider"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "TenantProvider_providerId_idx" ON "TenantProvider"("providerId");
CREATE INDEX IF NOT EXISTS "TenantProvider_tenantId_idx" ON "TenantProvider"("tenantId");

DO $$ BEGIN
  ALTER TABLE "TenantProvider"
    ADD CONSTRAINT "TenantProvider_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TenantProvider"
    ADD CONSTRAINT "TenantProvider_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CredentialingCase" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Document_tenantId_idx" ON "Document"("tenantId");
CREATE INDEX IF NOT EXISTS "Document_tenantId_status_idx" ON "Document"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "CredentialingCase_tenantId_idx" ON "CredentialingCase"("tenantId");
CREATE INDEX IF NOT EXISTS "CredentialingCase_tenantId_status_idx" ON "CredentialingCase"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "EnrollmentApplication_tenantId_idx" ON "EnrollmentApplication"("tenantId");
CREATE INDEX IF NOT EXISTS "EnrollmentApplication_tenantId_status_idx" ON "EnrollmentApplication"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Task_tenantId_idx" ON "Task"("tenantId");
CREATE INDEX IF NOT EXISTS "Task_tenantId_status_idx" ON "Task"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "IntakeRequest_tenantId_idx" ON "IntakeRequest"("tenantId");
CREATE INDEX IF NOT EXISTS "IntakeRequest_tenantId_status_idx" ON "IntakeRequest"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CredentialingCase" ADD CONSTRAINT "CredentialingCase_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "EnrollmentApplication" ADD CONSTRAINT "EnrollmentApplication_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "IntakeRequest" ADD CONSTRAINT "IntakeRequest_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Deterministic TenantProvider backfill from org / practice / facility affiliations.
INSERT INTO "TenantProvider" ("id", "tenantId", "providerId", "createdAt", "updatedAt")
SELECT md5(o."tenantId" || ':' || po."providerId"), o."tenantId", po."providerId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ProviderOrganization" po
JOIN "Organization" o ON o."id" = po."organizationId"
WHERE o."tenantId" IS NOT NULL
ON CONFLICT ("tenantId", "providerId") DO NOTHING;
-- (subsequent TenantProvider inserts also use ON CONFLICT on tenantId+providerId)

INSERT INTO "TenantProvider" ("id", "tenantId", "providerId", "createdAt", "updatedAt")
SELECT md5(o."tenantId" || ':' || pp."providerId"), o."tenantId", pp."providerId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "ProviderPractice" pp
JOIN "Practice" p ON p."id" = pp."practiceId"
JOIN "Organization" o ON o."id" = p."organizationId"
WHERE o."tenantId" IS NOT NULL
ON CONFLICT ("tenantId", "providerId") DO NOTHING;

INSERT INTO "TenantProvider" ("id", "tenantId", "providerId", "createdAt", "updatedAt")
SELECT md5(COALESCE(o."tenantId", o2."tenantId") || ':' || pf."providerId"),
       COALESCE(o."tenantId", o2."tenantId"),
       pf."providerId",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "ProviderFacility" pf
JOIN "Facility" f ON f."id" = pf."facilityId"
LEFT JOIN "Organization" o ON o."id" = f."organizationId"
LEFT JOIN "Practice" pr ON pr."id" = f."practiceId"
LEFT JOIN "Organization" o2 ON o2."id" = pr."organizationId"
WHERE COALESCE(o."tenantId", o2."tenantId") IS NOT NULL
ON CONFLICT ("tenantId", "providerId") DO NOTHING;

-- Backfill tenantId on workflow/document records from known organization chains.
UPDATE "Document" d
SET "tenantId" = o."tenantId"
FROM "Organization" o
WHERE d."organizationId" = o."id" AND d."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "Document" d
SET "tenantId" = o."tenantId"
FROM "Practice" p
JOIN "Organization" o ON o."id" = p."organizationId"
WHERE d."practiceId" = p."id" AND d."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "Document" d
SET "tenantId" = COALESCE(o."tenantId", o2."tenantId")
FROM "Facility" f
LEFT JOIN "Organization" o ON o."id" = f."organizationId"
LEFT JOIN "Practice" p ON p."id" = f."practiceId"
LEFT JOIN "Organization" o2 ON o2."id" = p."organizationId"
WHERE d."facilityId" = f."id" AND d."tenantId" IS NULL AND COALESCE(o."tenantId", o2."tenantId") IS NOT NULL;

UPDATE "Document" d
SET "tenantId" = tp."tenantId"
FROM "TenantProvider" tp
WHERE d."providerId" = tp."providerId" AND d."tenantId" IS NULL;

UPDATE "EnrollmentApplication" e
SET "tenantId" = o."tenantId"
FROM "Organization" o
WHERE e."organizationId" = o."id" AND e."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "EnrollmentApplication" e
SET "tenantId" = o."tenantId"
FROM "Practice" p
JOIN "Organization" o ON o."id" = p."organizationId"
WHERE e."practiceId" = p."id" AND e."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "EnrollmentApplication" e
SET "tenantId" = COALESCE(o."tenantId", o2."tenantId")
FROM "Facility" f
LEFT JOIN "Organization" o ON o."id" = f."organizationId"
LEFT JOIN "Practice" p ON p."id" = f."practiceId"
LEFT JOIN "Organization" o2 ON o2."id" = p."organizationId"
WHERE e."facilityId" = f."id" AND e."tenantId" IS NULL AND COALESCE(o."tenantId", o2."tenantId") IS NOT NULL;

UPDATE "EnrollmentApplication" e
SET "tenantId" = tp."tenantId"
FROM "TenantProvider" tp
WHERE e."providerId" = tp."providerId" AND e."tenantId" IS NULL;

UPDATE "CredentialingCase" c
SET "tenantId" = o."tenantId"
FROM "Practice" p
JOIN "Organization" o ON o."id" = p."organizationId"
WHERE c."practiceId" = p."id" AND c."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "CredentialingCase" c
SET "tenantId" = tp."tenantId"
FROM "TenantProvider" tp
WHERE c."providerId" = tp."providerId" AND c."tenantId" IS NULL;

UPDATE "Task" t
SET "tenantId" = o."tenantId"
FROM "Organization" o
WHERE t."organizationId" = o."id" AND t."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "Task" t
SET "tenantId" = o."tenantId"
FROM "Practice" p
JOIN "Organization" o ON o."id" = p."organizationId"
WHERE t."practiceId" = p."id" AND t."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "Task" t
SET "tenantId" = e."tenantId"
FROM "EnrollmentApplication" e
WHERE t."enrollmentId" = e."id" AND t."tenantId" IS NULL AND e."tenantId" IS NOT NULL;

UPDATE "Task" t
SET "tenantId" = c."tenantId"
FROM "CredentialingCase" c
WHERE t."caseId" = c."id" AND t."tenantId" IS NULL AND c."tenantId" IS NOT NULL;

UPDATE "IntakeRequest" i
SET "tenantId" = o."tenantId"
FROM "Organization" o
WHERE i."organizationId" = o."id" AND i."tenantId" IS NULL AND o."tenantId" IS NOT NULL;

UPDATE "AuditEvent" a
SET "tenantId" = o."tenantId"
FROM "Organization" o
WHERE a."organizationId" = o."id" AND a."tenantId" IS NULL AND o."tenantId" IS NOT NULL;
