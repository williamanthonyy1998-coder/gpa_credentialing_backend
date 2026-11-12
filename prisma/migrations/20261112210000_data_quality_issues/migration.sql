-- Phase 1C: Data quality issue tracking (additive)

CREATE TYPE "DataQualityIssueType" AS ENUM (
  'DUPLICATE_EXACT',
  'DUPLICATE_STRONG',
  'DUPLICATE_POSSIBLE',
  'BROKEN_RELATIONSHIP',
  'UNMAPPED_LEGACY',
  'INVALID_REFERENCE',
  'MISSING_REQUIRED',
  'INCONSISTENT_STATUS',
  'NPI_INVALID',
  'SPECIALTY_CONFLICT',
  'CATEGORY_INCONSISTENCY',
  'OTHER'
);

CREATE TYPE "DataQualitySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TYPE "DataQualityIssueStatus" AS ENUM (
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED',
  'ACCEPTED_LEGITIMATE',
  'REOPENED'
);

CREATE TABLE "DataQualityIssue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "issueType" "DataQualityIssueType" NOT NULL,
    "severity" "DataQualitySeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "DataQualityIssueStatus" NOT NULL DEFAULT 'OPEN',
    "directoryType" TEXT NOT NULL,
    "recordId" TEXT,
    "relatedRecordId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "details" JSONB,
    "assignedToId" TEXT,
    "resolvedById" TEXT,
    "resolutionNotes" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataQualityIssue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataQualityIssue_fingerprint_key" ON "DataQualityIssue"("fingerprint");
CREATE INDEX "DataQualityIssue_tenantId_status_idx" ON "DataQualityIssue"("tenantId", "status");
CREATE INDEX "DataQualityIssue_directoryType_status_idx" ON "DataQualityIssue"("directoryType", "status");
CREATE INDEX "DataQualityIssue_issueType_status_idx" ON "DataQualityIssue"("issueType", "status");
CREATE INDEX "DataQualityIssue_severity_status_idx" ON "DataQualityIssue"("severity", "status");
CREATE INDEX "DataQualityIssue_detectedAt_idx" ON "DataQualityIssue"("detectedAt");

ALTER TABLE "DataQualityIssue" ADD CONSTRAINT "DataQualityIssue_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataQualityIssue" ADD CONSTRAINT "DataQualityIssue_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DataQualityIssue" ADD CONSTRAINT "DataQualityIssue_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
