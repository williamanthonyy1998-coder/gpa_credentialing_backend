-- Phase 4B: Payer requirements engine & enrollment packets (additive).
-- Preserves existing PayerRequirement rows and enrollment/document data.

ALTER TABLE "PayerRequirement"
  ADD COLUMN IF NOT EXISTS "category" TEXT,
  ADD COLUMN IF NOT EXISTS "isRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "enrollmentTypes" JSONB,
  ADD COLUMN IF NOT EXISTS "conditions" JSONB,
  ADD COLUMN IF NOT EXISTS "effectiveFrom" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "effectiveTo" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceReference" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "lastReviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "instructions" TEXT;

CREATE INDEX IF NOT EXISTS "PayerRequirement_code_version_status_idx"
  ON "PayerRequirement"("code", "version", "status");
CREATE INDEX IF NOT EXISTS "PayerRequirement_effectiveFrom_effectiveTo_idx"
  ON "PayerRequirement"("effectiveFrom", "effectiveTo");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayerRequirement_lastReviewedById_fkey'
  ) THEN
    ALTER TABLE "PayerRequirement"
      ADD CONSTRAINT "PayerRequirement_lastReviewedById_fkey"
      FOREIGN KEY ("lastReviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PayerRequirementHistory" (
  "id" TEXT NOT NULL,
  "requirementId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "changedById" TEXT,
  "changeReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayerRequirementHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PayerRequirementHistory_requirementId_version_idx"
  ON "PayerRequirementHistory"("requirementId", "version");
CREATE INDEX IF NOT EXISTS "PayerRequirementHistory_requirementId_createdAt_idx"
  ON "PayerRequirementHistory"("requirementId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PayerRequirementHistory_requirementId_fkey'
  ) THEN
    ALTER TABLE "PayerRequirementHistory"
      ADD CONSTRAINT "PayerRequirementHistory_requirementId_fkey"
      FOREIGN KEY ("requirementId") REFERENCES "PayerRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE "EnrollmentPacketStatus" AS ENUM (
    'NOT_EVALUATED',
    'INCOMPLETE',
    'EVIDENCE_PENDING',
    'REVIEW_REQUIRED',
    'READY_FOR_INTERNAL_SUBMISSION_REVIEW',
    'BLOCKED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PacketItemStatus" AS ENUM (
    'NOT_STARTED',
    'MISSING',
    'INFORMATION_AVAILABLE',
    'EVIDENCE_ATTACHED',
    'PENDING_REVIEW',
    'VERIFIED',
    'REJECTED',
    'EXPIRED',
    'NOT_APPLICABLE',
    'WAIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "EnrollmentPacket" (
  "id" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "EnrollmentPacketStatus" NOT NULL DEFAULT 'NOT_EVALUATED',
  "payerId" TEXT,
  "payerPlanId" TEXT NOT NULL,
  "enrollmentType" TEXT NOT NULL,
  "requirementSnapshot" JSONB NOT NULL,
  "evaluationSummary" JSONB,
  "conflictNotes" TEXT,
  "createdById" TEXT,
  "evaluatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentPacket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnrollmentPacket_enrollmentId_version_key"
  ON "EnrollmentPacket"("enrollmentId", "version");
CREATE INDEX IF NOT EXISTS "EnrollmentPacket_tenantId_enrollmentId_idx"
  ON "EnrollmentPacket"("tenantId", "enrollmentId");
CREATE INDEX IF NOT EXISTS "EnrollmentPacket_tenantId_status_idx"
  ON "EnrollmentPacket"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "EnrollmentPacket_enrollmentId_status_idx"
  ON "EnrollmentPacket"("enrollmentId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacket_enrollmentId_fkey') THEN
    ALTER TABLE "EnrollmentPacket"
      ADD CONSTRAINT "EnrollmentPacket_enrollmentId_fkey"
      FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacket_tenantId_fkey') THEN
    ALTER TABLE "EnrollmentPacket"
      ADD CONSTRAINT "EnrollmentPacket_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacket_createdById_fkey') THEN
    ALTER TABLE "EnrollmentPacket"
      ADD CONSTRAINT "EnrollmentPacket_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "EnrollmentPacketItem" (
  "id" TEXT NOT NULL,
  "packetId" TEXT NOT NULL,
  "payerRequirementId" TEXT,
  "requirementCode" TEXT,
  "requirementTitle" TEXT NOT NULL,
  "category" TEXT,
  "isRequired" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "status" "PacketItemStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "applicabilityReason" TEXT,
  "sourceType" TEXT,
  "sourceRecordId" TEXT,
  "sourceLabel" TEXT,
  "documentId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "reviewNotes" TEXT,
  "internalNotes" TEXT,
  "rejectionReason" TEXT,
  "waiverReason" TEXT,
  "waivedById" TEXT,
  "waivedAt" TIMESTAMP(3),
  "verifiedById" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "requirementVersion" INTEGER,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentPacketItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EnrollmentPacketItem_packetId_status_idx"
  ON "EnrollmentPacketItem"("packetId", "status");
CREATE INDEX IF NOT EXISTS "EnrollmentPacketItem_packetId_requirementCode_idx"
  ON "EnrollmentPacketItem"("packetId", "requirementCode");
CREATE INDEX IF NOT EXISTS "EnrollmentPacketItem_documentId_idx"
  ON "EnrollmentPacketItem"("documentId");
CREATE INDEX IF NOT EXISTS "EnrollmentPacketItem_payerRequirementId_idx"
  ON "EnrollmentPacketItem"("payerRequirementId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacketItem_packetId_fkey') THEN
    ALTER TABLE "EnrollmentPacketItem"
      ADD CONSTRAINT "EnrollmentPacketItem_packetId_fkey"
      FOREIGN KEY ("packetId") REFERENCES "EnrollmentPacket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacketItem_payerRequirementId_fkey') THEN
    ALTER TABLE "EnrollmentPacketItem"
      ADD CONSTRAINT "EnrollmentPacketItem_payerRequirementId_fkey"
      FOREIGN KEY ("payerRequirementId") REFERENCES "PayerRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacketItem_documentId_fkey') THEN
    ALTER TABLE "EnrollmentPacketItem"
      ADD CONSTRAINT "EnrollmentPacketItem_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "EnrollmentPacketItemEvent" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "actorId" TEXT,
  "actorRole" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentPacketItemEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EnrollmentPacketItemEvent_itemId_createdAt_idx"
  ON "EnrollmentPacketItemEvent"("itemId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentPacketItemEvent_itemId_fkey') THEN
    ALTER TABLE "EnrollmentPacketItemEvent"
      ADD CONSTRAINT "EnrollmentPacketItemEvent_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "EnrollmentPacketItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
