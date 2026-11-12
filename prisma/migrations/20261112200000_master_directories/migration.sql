-- Phase 1A: master directory tables, payer/plan/provider/license enhancements, deterministic backfills.
-- PayerPlan.checklist -> PayerRequirement conversion is handled in prisma/seed-directories.ts (JSON array parsing).

DO $$ BEGIN
  CREATE TYPE "DirectoryScope" AS ENUM ('PLATFORM', 'TENANT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "UsState" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "fipsCode" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UsState_abbreviation_key" ON "UsState"("abbreviation");
CREATE UNIQUE INDEX IF NOT EXISTS "UsState_fipsCode_key" ON "UsState"("fipsCode") WHERE "fipsCode" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "UsState_status_idx" ON "UsState"("status");

CREATE TABLE IF NOT EXISTS "Specialty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Specialty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Specialty_name_key" ON "Specialty"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Specialty_code_key" ON "Specialty"("code") WHERE "code" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Specialty_status_idx" ON "Specialty"("status");

CREATE TABLE IF NOT EXISTS "ProviderSpecialty" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isSecondary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderSpecialty_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderSpecialty_providerId_specialtyId_key" ON "ProviderSpecialty"("providerId", "specialtyId");
CREATE INDEX IF NOT EXISTS "ProviderSpecialty_specialtyId_idx" ON "ProviderSpecialty"("specialtyId");

CREATE TABLE IF NOT EXISTS "LicenseType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "profession" TEXT,
    "applicableStateCodes" JSONB,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LicenseType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LicenseType_code_key" ON "LicenseType"("code");
CREATE INDEX IF NOT EXISTS "LicenseType_status_idx" ON "LicenseType"("status");
CREATE INDEX IF NOT EXISTS "LicenseType_profession_status_idx" ON "LicenseType"("profession", "status");

CREATE TABLE IF NOT EXISTS "DegreeType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DegreeType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DegreeType_code_key" ON "DegreeType"("code");
CREATE INDEX IF NOT EXISTS "DegreeType_status_idx" ON "DegreeType"("status");

CREATE TABLE IF NOT EXISTS "EducationType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EducationType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EducationType_code_key" ON "EducationType"("code");
CREATE INDEX IF NOT EXISTS "EducationType_status_idx" ON "EducationType"("status");

CREATE TABLE IF NOT EXISTS "ResidencyType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResidencyType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ResidencyType_code_key" ON "ResidencyType"("code");
CREATE INDEX IF NOT EXISTS "ResidencyType_status_idx" ON "ResidencyType"("status");

CREATE TABLE IF NOT EXISTS "FellowshipType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FellowshipType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FellowshipType_code_key" ON "FellowshipType"("code");
CREATE INDEX IF NOT EXISTS "FellowshipType_status_idx" ON "FellowshipType"("status");

CREATE TABLE IF NOT EXISTS "BoardCertificationCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BoardCertificationCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BoardCertificationCategory_code_key" ON "BoardCertificationCategory"("code");
CREATE INDEX IF NOT EXISTS "BoardCertificationCategory_status_idx" ON "BoardCertificationCategory"("status");

CREATE TABLE IF NOT EXISTS "CertificationType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CertificationType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CertificationType_code_key" ON "CertificationType"("code");
CREATE INDEX IF NOT EXISTS "CertificationType_status_idx" ON "CertificationType"("status");

CREATE TABLE IF NOT EXISTS "CredentialCategory" (
    "id" TEXT NOT NULL,
    "scope" "DirectoryScope" NOT NULL DEFAULT 'PLATFORM',
    "tenantId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requiredDefault" BOOLEAN NOT NULL DEFAULT false,
    "tracksExpiration" BOOLEAN NOT NULL DEFAULT false,
    "defaultWarningDays" INTEGER,
    "applicableProviderTypes" JSONB,
    "applicableSpecialties" JSONB,
    "documentTypes" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CredentialCategory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CredentialCategory_scope_code_idx" ON "CredentialCategory"("scope", "code");
CREATE INDEX IF NOT EXISTS "CredentialCategory_tenantId_code_idx" ON "CredentialCategory"("tenantId", "code");
CREATE INDEX IF NOT EXISTS "CredentialCategory_scope_status_idx" ON "CredentialCategory"("scope", "status");
CREATE INDEX IF NOT EXISTS "CredentialCategory_tenantId_status_idx" ON "CredentialCategory"("tenantId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "CredentialCategory_platform_code_key"
  ON "CredentialCategory"("code")
  WHERE "scope" = 'PLATFORM' AND "tenantId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "CredentialCategory_tenant_code_key"
  ON "CredentialCategory"("tenantId", "code")
  WHERE "scope" = 'TENANT' AND "tenantId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "PayerContact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "payerPlanId" TEXT,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "jobTitle" TEXT,
    "phone" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "address" JSONB,
    "contactType" TEXT,
    "notes" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayerContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayerContact_tenantId_payerId_idx" ON "PayerContact"("tenantId", "payerId");
CREATE INDEX IF NOT EXISTS "PayerContact_tenantId_status_idx" ON "PayerContact"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PayerContact_payerPlanId_idx" ON "PayerContact"("payerPlanId");

CREATE TABLE IF NOT EXISTS "BillingEntity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT,
    "legalName" TEXT NOT NULL,
    "dba" TEXT,
    "taxId" TEXT,
    "npi" TEXT,
    "entityType" TEXT,
    "billingAddress" JSONB,
    "mailingAddress" JSONB,
    "contactName" TEXT,
    "contactTitle" TEXT,
    "phone" TEXT,
    "fax" TEXT,
    "email" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingEntity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BillingEntity_tenantId_status_idx" ON "BillingEntity"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "BillingEntity_organizationId_idx" ON "BillingEntity"("organizationId");
CREATE INDEX IF NOT EXISTS "BillingEntity_tenantId_legalName_idx" ON "BillingEntity"("tenantId", "legalName");

CREATE TABLE IF NOT EXISTS "BillingEntityPractice" (
    "billingEntityId" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingEntityPractice_pkey" PRIMARY KEY ("billingEntityId","practiceId")
);

CREATE INDEX IF NOT EXISTS "BillingEntityPractice_practiceId_idx" ON "BillingEntityPractice"("practiceId");

CREATE TABLE IF NOT EXISTS "PayerRequirement" (
    "id" TEXT NOT NULL,
    "scope" "DirectoryScope" NOT NULL DEFAULT 'PLATFORM',
    "tenantId" TEXT,
    "payerId" TEXT,
    "payerPlanId" TEXT,
    "code" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "requirementKind" TEXT,
    "appliesToProviderTypes" JSONB,
    "appliesToSpecialties" JSONB,
    "appliesToStates" JSONB,
    "appliesToFacility" BOOLEAN NOT NULL DEFAULT false,
    "appliesToGroup" BOOLEAN NOT NULL DEFAULT false,
    "documentCategoryCode" TEXT,
    "tracksExpiration" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayerRequirement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayerRequirement_scope_status_idx" ON "PayerRequirement"("scope", "status");
CREATE INDEX IF NOT EXISTS "PayerRequirement_tenantId_status_idx" ON "PayerRequirement"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PayerRequirement_payerId_status_idx" ON "PayerRequirement"("payerId", "status");
CREATE INDEX IF NOT EXISTS "PayerRequirement_payerPlanId_status_idx" ON "PayerRequirement"("payerPlanId", "status");
CREATE INDEX IF NOT EXISTS "PayerRequirement_scope_payerPlanId_code_idx" ON "PayerRequirement"("scope", "payerPlanId", "code");

-- Payer / PayerPlan enhancements
ALTER TABLE "Payer" ADD COLUMN IF NOT EXISTS "legalName" TEXT;
ALTER TABLE "Payer" ADD COLUMN IF NOT EXISTS "payerType" TEXT;
ALTER TABLE "Payer" ADD COLUMN IF NOT EXISTS "fax" TEXT;
ALTER TABLE "Payer" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "Payer" ADD COLUMN IF NOT EXISTS "address" JSONB;
ALTER TABLE "Payer" ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "PayerPlan" ADD COLUMN IF NOT EXISTS "planCode" TEXT;
ALTER TABLE "PayerPlan" ADD COLUMN IF NOT EXISTS "stateApplicability" TEXT;
ALTER TABLE "PayerPlan" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "PayerPlan" ADD COLUMN IF NOT EXISTS "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX IF NOT EXISTS "Payer_payerType_status_idx" ON "Payer"("payerType", "status");
CREATE INDEX IF NOT EXISTS "PayerPlan_status_idx" ON "PayerPlan"("status");
CREATE INDEX IF NOT EXISTS "PayerPlan_payerId_status_idx" ON "PayerPlan"("payerId", "status");

-- Provider specialty FK columns
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "primarySpecialtyId" TEXT;
ALTER TABLE "Provider" ADD COLUMN IF NOT EXISTS "secondarySpecialtyId" TEXT;

CREATE INDEX IF NOT EXISTS "Provider_primarySpecialtyId_idx" ON "Provider"("primarySpecialtyId");
CREATE INDEX IF NOT EXISTS "Provider_secondarySpecialtyId_idx" ON "Provider"("secondarySpecialtyId");

DO $$ BEGIN
  ALTER TABLE "Provider" ADD CONSTRAINT "Provider_primarySpecialtyId_fkey"
    FOREIGN KEY ("primarySpecialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Provider" ADD CONSTRAINT "Provider_secondarySpecialtyId_fkey"
    FOREIGN KEY ("secondarySpecialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- License directory FK columns
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "licenseTypeId" TEXT;
ALTER TABLE "License" ADD COLUMN IF NOT EXISTS "usStateId" TEXT;

CREATE INDEX IF NOT EXISTS "License_licenseTypeId_idx" ON "License"("licenseTypeId");
CREATE INDEX IF NOT EXISTS "License_usStateId_idx" ON "License"("usStateId");

DO $$ BEGIN
  ALTER TABLE "License" ADD CONSTRAINT "License_licenseTypeId_fkey"
    FOREIGN KEY ("licenseTypeId") REFERENCES "LicenseType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "License" ADD CONSTRAINT "License_usStateId_fkey"
    FOREIGN KEY ("usStateId") REFERENCES "UsState"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Directory table foreign keys
DO $$ BEGIN
  ALTER TABLE "ProviderSpecialty" ADD CONSTRAINT "ProviderSpecialty_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ProviderSpecialty" ADD CONSTRAINT "ProviderSpecialty_specialtyId_fkey"
    FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CredentialCategory" ADD CONSTRAINT "CredentialCategory_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayerContact" ADD CONSTRAINT "PayerContact_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayerContact" ADD CONSTRAINT "PayerContact_payerId_fkey"
    FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayerContact" ADD CONSTRAINT "PayerContact_payerPlanId_fkey"
    FOREIGN KEY ("payerPlanId") REFERENCES "PayerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BillingEntity" ADD CONSTRAINT "BillingEntity_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BillingEntity" ADD CONSTRAINT "BillingEntity_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BillingEntityPractice" ADD CONSTRAINT "BillingEntityPractice_billingEntityId_fkey"
    FOREIGN KEY ("billingEntityId") REFERENCES "BillingEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BillingEntityPractice" ADD CONSTRAINT "BillingEntityPractice_practiceId_fkey"
    FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayerRequirement" ADD CONSTRAINT "PayerRequirement_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayerRequirement" ADD CONSTRAINT "PayerRequirement_payerId_fkey"
    FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayerRequirement" ADD CONSTRAINT "PayerRequirement_payerPlanId_fkey"
    FOREIGN KEY ("payerPlanId") REFERENCES "PayerPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Deterministic specialty backfill from legacy Provider text fields
INSERT INTO "Specialty" ("id", "name", "status", "createdAt", "updatedAt")
SELECT md5('legacy-specialty:' || d.norm), d.display_name, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (norm)
    lower(trim("primarySpecialty")) AS norm,
    trim("primarySpecialty") AS display_name
  FROM "Provider"
  WHERE "primarySpecialty" IS NOT NULL AND trim("primarySpecialty") <> ''
  ORDER BY norm
) d
WHERE NOT EXISTS (SELECT 1 FROM "Specialty" s WHERE lower(s."name") = d.norm)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "Specialty" ("id", "name", "status", "createdAt", "updatedAt")
SELECT md5('legacy-specialty:' || d.norm), d.display_name, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (norm)
    lower(trim("secondarySpecialty")) AS norm,
    trim("secondarySpecialty") AS display_name
  FROM "Provider"
  WHERE "secondarySpecialty" IS NOT NULL AND trim("secondarySpecialty") <> ''
  ORDER BY norm
) d
WHERE NOT EXISTS (SELECT 1 FROM "Specialty" s WHERE lower(s."name") = d.norm)
ON CONFLICT ("name") DO NOTHING;

UPDATE "Provider" p
SET "primarySpecialtyId" = s."id", "updatedAt" = CURRENT_TIMESTAMP
FROM "Specialty" s
WHERE p."primarySpecialty" IS NOT NULL
  AND trim(p."primarySpecialty") <> ''
  AND lower(trim(p."primarySpecialty")) = lower(s."name")
  AND (p."primarySpecialtyId" IS NULL OR p."primarySpecialtyId" IS DISTINCT FROM s."id");

UPDATE "Provider" p
SET "secondarySpecialtyId" = s."id", "updatedAt" = CURRENT_TIMESTAMP
FROM "Specialty" s
WHERE p."secondarySpecialty" IS NOT NULL
  AND trim(p."secondarySpecialty") <> ''
  AND lower(trim(p."secondarySpecialty")) = lower(s."name")
  AND (p."secondarySpecialtyId" IS NULL OR p."secondarySpecialtyId" IS DISTINCT FROM s."id");

INSERT INTO "ProviderSpecialty" ("id", "providerId", "specialtyId", "isPrimary", "isSecondary", "createdAt", "updatedAt")
SELECT md5(p."id" || ':' || p."primarySpecialtyId"), p."id", p."primarySpecialtyId", true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Provider" p
WHERE p."primarySpecialtyId" IS NOT NULL
ON CONFLICT ("providerId", "specialtyId") DO UPDATE SET "isPrimary" = true, "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "ProviderSpecialty" ("id", "providerId", "specialtyId", "isPrimary", "isSecondary", "createdAt", "updatedAt")
SELECT md5(p."id" || ':' || p."secondarySpecialtyId"), p."id", p."secondarySpecialtyId", false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Provider" p
WHERE p."secondarySpecialtyId" IS NOT NULL
ON CONFLICT ("providerId", "specialtyId") DO UPDATE SET "isSecondary" = true, "updatedAt" = CURRENT_TIMESTAMP;

-- UsState rows are seeded via seed-directories.ts; link licenses when abbreviation matches.
UPDATE "License" l
SET "usStateId" = s."id", "updatedAt" = CURRENT_TIMESTAMP
FROM "UsState" s
WHERE l."state" IS NOT NULL
  AND upper(trim(l."state")) = upper(s."abbreviation")
  AND (l."usStateId" IS NULL OR l."usStateId" IS DISTINCT FROM s."id");
