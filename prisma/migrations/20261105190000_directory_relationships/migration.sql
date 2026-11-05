-- Directory relationship expansion. Additive and data-preserving.
ALTER TABLE "Facility" DROP CONSTRAINT "Facility_practiceId_fkey";
ALTER TABLE "Facility" ALTER COLUMN "practiceId" DROP NOT NULL;
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Facility" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "EnrollmentApplication" DROP CONSTRAINT "EnrollmentApplication_providerId_fkey";
ALTER TABLE "EnrollmentApplication" ALTER COLUMN "providerId" DROP NOT NULL;
ALTER TABLE "EnrollmentApplication" ADD CONSTRAINT "EnrollmentApplication_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentApplication" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "EnrollmentApplication" ADD COLUMN "facilityId" TEXT;

-- Preserve and connect existing records to their owning organization.
UPDATE "Facility" f
SET "organizationId" = p."organizationId"
FROM "Practice" p
WHERE f."practiceId" = p."id" AND f."organizationId" IS NULL;

UPDATE "EnrollmentApplication" e
SET "organizationId" = p."organizationId"
FROM "Practice" p
WHERE e."practiceId" = p."id" AND e."organizationId" IS NULL;


CREATE TABLE "ProviderOrganization" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "affiliationTitle" TEXT,
  "effectiveAt" TIMESTAMP(3),
  "endAt" TIMESTAMP(3),
  "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderOrganization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderOrganization_providerId_organizationId_key" ON "ProviderOrganization"("providerId", "organizationId");
CREATE INDEX "ProviderOrganization_organizationId_status_idx" ON "ProviderOrganization"("organizationId", "status");
CREATE INDEX "Facility_organizationId_idx" ON "Facility"("organizationId");
CREATE INDEX "EnrollmentApplication_organizationId_status_idx" ON "EnrollmentApplication"("organizationId", "status");
CREATE INDEX "EnrollmentApplication_providerId_payerPlanId_idx" ON "EnrollmentApplication"("providerId", "payerPlanId");

ALTER TABLE "Facility" ADD CONSTRAINT "Facility_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentApplication" ADD CONSTRAINT "EnrollmentApplication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentApplication" ADD CONSTRAINT "EnrollmentApplication_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProviderOrganization" ADD CONSTRAINT "ProviderOrganization_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderOrganization" ADD CONSTRAINT "ProviderOrganization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
