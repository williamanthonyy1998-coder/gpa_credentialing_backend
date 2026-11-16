-- Phase 5A: Organization employee HR assignments + payer participation

CREATE TYPE "OrganizationEmploymentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING', 'TERMINATED');
CREATE TYPE "OrganizationPayerParticipationStatus" AS ENUM (
  'NOT_CONTRACTED',
  'CONTRACTING',
  'CONTRACTED',
  'ACTIVE',
  'SUSPENDED',
  'TERMINATED',
  'PENDING_RENEWAL'
);

CREATE TABLE "OrganizationEmployee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "department" TEXT,
    "jobTitle" TEXT,
    "employmentStatus" "OrganizationEmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "responsibilities" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationEmployee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationEmployee_organizationId_userId_key" ON "OrganizationEmployee"("organizationId", "userId");
CREATE INDEX "OrganizationEmployee_organizationId_employmentStatus_idx" ON "OrganizationEmployee"("organizationId", "employmentStatus");
CREATE INDEX "OrganizationEmployee_userId_idx" ON "OrganizationEmployee"("userId");

ALTER TABLE "OrganizationEmployee" ADD CONSTRAINT "OrganizationEmployee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationEmployee" ADD CONSTRAINT "OrganizationEmployee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OrganizationPayer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "participationStatus" "OrganizationPayerParticipationStatus" NOT NULL DEFAULT 'CONTRACTING',
    "contractReference" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "terminationDate" TIMESTAMP(3),
    "renewalDate" TIMESTAMP(3),
    "assignedContactId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationPayer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationPayer_organizationId_payerId_key" ON "OrganizationPayer"("organizationId", "payerId");
CREATE INDEX "OrganizationPayer_organizationId_participationStatus_idx" ON "OrganizationPayer"("organizationId", "participationStatus");
CREATE INDEX "OrganizationPayer_payerId_idx" ON "OrganizationPayer"("payerId");
CREATE INDEX "OrganizationPayer_renewalDate_idx" ON "OrganizationPayer"("renewalDate");

ALTER TABLE "OrganizationPayer" ADD CONSTRAINT "OrganizationPayer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationPayer" ADD CONSTRAINT "OrganizationPayer_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrganizationPayer" ADD CONSTRAINT "OrganizationPayer_assignedContactId_fkey" FOREIGN KEY ("assignedContactId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
