-- Phase 3A: Structured provider professional history (additive, tenant-scoped).

DO $$ BEGIN
  CREATE TYPE "HistoryVerificationStatus" AS ENUM (
    'NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'UNABLE_TO_VERIFY'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ProfessionalHistorySection" AS ENUM (
    'EDUCATION', 'RESIDENCY', 'FELLOWSHIP', 'BOARD_CERTIFICATION',
    'PROFESSIONAL_CERTIFICATION', 'EMPLOYMENT', 'HOSPITAL_AFFILIATION', 'MALPRACTICE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "HistoryCompletionStatus" AS ENUM (
    'IN_PROGRESS', 'COMPLETED', 'WITHDRAWN', 'TRANSFERRED', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "HistoryRecordStatus" AS ENUM (
    'ACTIVE', 'INACTIVE', 'ARCHIVED', 'CURRENT', 'EXPIRED', 'PENDING'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ProviderEducation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "institutionName" TEXT NOT NULL,
  "degreeTypeId" TEXT,
  "degreeName" TEXT,
  "fieldOfStudy" TEXT,
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "graduationDate" TIMESTAMP(3),
  "country" TEXT,
  "state" TEXT,
  "city" TEXT,
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "recordStatus" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderEducation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderResidency" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "institutionName" TEXT NOT NULL,
  "programName" TEXT,
  "specialtyId" TEXT,
  "specialtyName" TEXT,
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "completionStatus" "HistoryCompletionStatus" NOT NULL DEFAULT 'COMPLETED',
  "country" TEXT,
  "state" TEXT,
  "city" TEXT,
  "programDirector" TEXT,
  "contactInfo" TEXT,
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "recordStatus" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderResidency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderFellowship" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "institutionName" TEXT NOT NULL,
  "programName" TEXT,
  "specialtyId" TEXT,
  "specialtyName" TEXT,
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "completionStatus" "HistoryCompletionStatus" NOT NULL DEFAULT 'COMPLETED',
  "country" TEXT,
  "state" TEXT,
  "city" TEXT,
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "recordStatus" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFellowship_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderBoardCertification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "categoryId" TEXT,
  "certifyingBoard" TEXT NOT NULL,
  "specialtyId" TEXT,
  "specialtyName" TEXT,
  "certificationNumber" TEXT,
  "issueDate" TIMESTAMP(3),
  "expirationDate" TIMESTAMP(3),
  "doesNotExpire" BOOLEAN NOT NULL DEFAULT false,
  "status" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderBoardCertification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderProfessionalCertification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "certificationName" TEXT NOT NULL,
  "certificationTypeId" TEXT,
  "certificationTypeName" TEXT,
  "issuingOrganization" TEXT,
  "certificateNumber" TEXT,
  "issueDate" TIMESTAMP(3),
  "expirationDate" TIMESTAMP(3),
  "status" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderProfessionalCertification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderEmployment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "employerName" TEXT NOT NULL,
  "employerType" TEXT,
  "positionTitle" TEXT,
  "specialtyOrDept" TEXT,
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "country" TEXT,
  "state" TEXT,
  "city" TEXT,
  "locationText" TEXT,
  "supervisorName" TEXT,
  "contactInfo" TEXT,
  "reasonForLeaving" TEXT,
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "recordStatus" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderEmployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderHospitalAffiliation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "facilityId" TEXT,
  "hospitalName" TEXT,
  "affiliationType" TEXT,
  "department" TEXT,
  "effectiveDate" TIMESTAMP(3),
  "expirationDate" TIMESTAMP(3),
  "status" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "privilegeStatus" TEXT,
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderHospitalAffiliation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProviderMalpracticePolicy" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "insuranceCarrier" TEXT NOT NULL,
  "policyNumber" TEXT,
  "coverageType" TEXT,
  "perOccurrenceAmount" DECIMAL(14,2),
  "aggregateAmount" DECIMAL(14,2),
  "effectiveDate" TIMESTAMP(3),
  "expirationDate" TIMESTAMP(3),
  "retroactiveDate" TIMESTAMP(3),
  "hasTailCoverage" BOOLEAN,
  "tailCoverageNotes" TEXT,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  "status" "HistoryRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "verificationStatus" "HistoryVerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "verifiedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "rejectionReason" TEXT,
  "reviewerNotes" TEXT,
  "notes" TEXT,
  "documentId" TEXT,
  "sourceIntakeId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderMalpracticePolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProfessionalHistoryDocument" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "section" "ProfessionalHistorySection" NOT NULL,
  "recordId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfessionalHistoryDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProfessionalHistoryVerificationEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "section" "ProfessionalHistorySection" NOT NULL,
  "recordId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "fromStatus" "HistoryVerificationStatus",
  "toStatus" "HistoryVerificationStatus" NOT NULL,
  "reason" TEXT,
  "actorId" TEXT,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProfessionalHistoryVerificationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProviderEducation_tenantId_providerId_idx" ON "ProviderEducation"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderEducation_providerId_verificationStatus_idx" ON "ProviderEducation"("providerId", "verificationStatus");
CREATE INDEX IF NOT EXISTS "ProviderResidency_tenantId_providerId_idx" ON "ProviderResidency"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderFellowship_tenantId_providerId_idx" ON "ProviderFellowship"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderBoardCertification_tenantId_providerId_idx" ON "ProviderBoardCertification"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderBoardCertification_expirationDate_idx" ON "ProviderBoardCertification"("expirationDate");
CREATE INDEX IF NOT EXISTS "ProviderProfessionalCertification_tenantId_providerId_idx" ON "ProviderProfessionalCertification"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderEmployment_tenantId_providerId_idx" ON "ProviderEmployment"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderHospitalAffiliation_tenantId_providerId_idx" ON "ProviderHospitalAffiliation"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderMalpracticePolicy_tenantId_providerId_idx" ON "ProviderMalpracticePolicy"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProviderMalpracticePolicy_expirationDate_idx" ON "ProviderMalpracticePolicy"("expirationDate");
CREATE UNIQUE INDEX IF NOT EXISTS "ProfessionalHistoryDocument_section_recordId_documentId_key" ON "ProfessionalHistoryDocument"("section", "recordId", "documentId");
CREATE INDEX IF NOT EXISTS "ProfessionalHistoryDocument_tenantId_providerId_idx" ON "ProfessionalHistoryDocument"("tenantId", "providerId");
CREATE INDEX IF NOT EXISTS "ProfessionalHistoryVerificationEvent_tenantId_providerId_createdAt_idx" ON "ProfessionalHistoryVerificationEvent"("tenantId", "providerId", "createdAt");

DO $$ BEGIN ALTER TABLE "ProviderEducation" ADD CONSTRAINT "ProviderEducation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderEducation" ADD CONSTRAINT "ProviderEducation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderEducation" ADD CONSTRAINT "ProviderEducation_degreeTypeId_fkey" FOREIGN KEY ("degreeTypeId") REFERENCES "DegreeType"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderResidency" ADD CONSTRAINT "ProviderResidency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderResidency" ADD CONSTRAINT "ProviderResidency_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderResidency" ADD CONSTRAINT "ProviderResidency_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderFellowship" ADD CONSTRAINT "ProviderFellowship_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderFellowship" ADD CONSTRAINT "ProviderFellowship_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderFellowship" ADD CONSTRAINT "ProviderFellowship_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderBoardCertification" ADD CONSTRAINT "ProviderBoardCertification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderBoardCertification" ADD CONSTRAINT "ProviderBoardCertification_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderBoardCertification" ADD CONSTRAINT "ProviderBoardCertification_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BoardCertificationCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderBoardCertification" ADD CONSTRAINT "ProviderBoardCertification_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderProfessionalCertification" ADD CONSTRAINT "ProviderProfessionalCertification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderProfessionalCertification" ADD CONSTRAINT "ProviderProfessionalCertification_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderProfessionalCertification" ADD CONSTRAINT "ProviderProfessionalCertification_certificationTypeId_fkey" FOREIGN KEY ("certificationTypeId") REFERENCES "CertificationType"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderEmployment" ADD CONSTRAINT "ProviderEmployment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderEmployment" ADD CONSTRAINT "ProviderEmployment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderHospitalAffiliation" ADD CONSTRAINT "ProviderHospitalAffiliation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderHospitalAffiliation" ADD CONSTRAINT "ProviderHospitalAffiliation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderHospitalAffiliation" ADD CONSTRAINT "ProviderHospitalAffiliation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProviderMalpracticePolicy" ADD CONSTRAINT "ProviderMalpracticePolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProviderMalpracticePolicy" ADD CONSTRAINT "ProviderMalpracticePolicy_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProfessionalHistoryDocument" ADD CONSTRAINT "ProfessionalHistoryDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProfessionalHistoryDocument" ADD CONSTRAINT "ProfessionalHistoryDocument_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "ProfessionalHistoryVerificationEvent" ADD CONSTRAINT "ProfessionalHistoryVerificationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProfessionalHistoryVerificationEvent" ADD CONSTRAINT "ProfessionalHistoryVerificationEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
