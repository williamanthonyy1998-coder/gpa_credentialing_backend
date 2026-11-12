-- Phase 4C: Submission attempts, payer communications, follow-up task fields (additive).

DO $$ BEGIN
  CREATE TYPE "EnrollmentSubmissionStatus" AS ENUM ('PREPARED', 'CONFIRMED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "followUpType" TEXT,
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completionNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "submissionId" TEXT,
  ADD COLUMN IF NOT EXISTS "communicationId" TEXT;

CREATE INDEX IF NOT EXISTS "Task_tenantId_followUpType_status_idx"
  ON "Task"("tenantId", "followUpType", "status");
CREATE INDEX IF NOT EXISTS "Task_submissionId_idx" ON "Task"("submissionId");
CREATE INDEX IF NOT EXISTS "Task_communicationId_idx" ON "Task"("communicationId");

CREATE TABLE IF NOT EXISTS "EnrollmentSubmission" (
  "id" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "packetId" TEXT,
  "packetVersion" INTEGER,
  "channel" TEXT NOT NULL,
  "channelExplanation" TEXT,
  "submittedAt" TIMESTAMP(3),
  "submittedById" TEXT,
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "referenceNo" TEXT,
  "evidenceDocumentId" TEXT,
  "notes" TEXT,
  "internalNotes" TEXT,
  "confirmationStatus" "EnrollmentSubmissionStatus" NOT NULL DEFAULT 'PREPARED',
  "confirmedSent" BOOLEAN NOT NULL DEFAULT false,
  "overrideReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnrollmentSubmission_enrollmentId_attemptNumber_key"
  ON "EnrollmentSubmission"("enrollmentId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "EnrollmentSubmission_tenantId_enrollmentId_idx"
  ON "EnrollmentSubmission"("tenantId", "enrollmentId");
CREATE INDEX IF NOT EXISTS "EnrollmentSubmission_enrollmentId_submittedAt_idx"
  ON "EnrollmentSubmission"("enrollmentId", "submittedAt");
CREATE INDEX IF NOT EXISTS "EnrollmentSubmission_tenantId_confirmationStatus_idx"
  ON "EnrollmentSubmission"("tenantId", "confirmationStatus");
CREATE INDEX IF NOT EXISTS "EnrollmentSubmission_packetId_idx" ON "EnrollmentSubmission"("packetId");
CREATE INDEX IF NOT EXISTS "EnrollmentSubmission_evidenceDocumentId_idx" ON "EnrollmentSubmission"("evidenceDocumentId");

CREATE TABLE IF NOT EXISTS "EnrollmentCommunication" (
  "id" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "submissionId" TEXT,
  "communicationType" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "channelExplanation" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contactName" TEXT,
  "contactDepartment" TEXT,
  "referenceNo" TEXT,
  "summary" TEXT NOT NULL,
  "notes" TEXT,
  "internalNotes" TEXT,
  "evidenceDocumentId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentCommunication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EnrollmentCommunication_tenantId_enrollmentId_idx"
  ON "EnrollmentCommunication"("tenantId", "enrollmentId");
CREATE INDEX IF NOT EXISTS "EnrollmentCommunication_enrollmentId_createdAt_idx"
  ON "EnrollmentCommunication"("enrollmentId", "createdAt");
CREATE INDEX IF NOT EXISTS "EnrollmentCommunication_communicationType_createdAt_idx"
  ON "EnrollmentCommunication"("communicationType", "createdAt");
CREATE INDEX IF NOT EXISTS "EnrollmentCommunication_submissionId_idx"
  ON "EnrollmentCommunication"("submissionId");
CREATE INDEX IF NOT EXISTS "EnrollmentCommunication_evidenceDocumentId_idx"
  ON "EnrollmentCommunication"("evidenceDocumentId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentSubmission_enrollmentId_fkey') THEN
    ALTER TABLE "EnrollmentSubmission" ADD CONSTRAINT "EnrollmentSubmission_enrollmentId_fkey"
      FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentSubmission_tenantId_fkey') THEN
    ALTER TABLE "EnrollmentSubmission" ADD CONSTRAINT "EnrollmentSubmission_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentSubmission_packetId_fkey') THEN
    ALTER TABLE "EnrollmentSubmission" ADD CONSTRAINT "EnrollmentSubmission_packetId_fkey"
      FOREIGN KEY ("packetId") REFERENCES "EnrollmentPacket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentSubmission_submittedById_fkey') THEN
    ALTER TABLE "EnrollmentSubmission" ADD CONSTRAINT "EnrollmentSubmission_submittedById_fkey"
      FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentSubmission_confirmedById_fkey') THEN
    ALTER TABLE "EnrollmentSubmission" ADD CONSTRAINT "EnrollmentSubmission_confirmedById_fkey"
      FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentSubmission_evidenceDocumentId_fkey') THEN
    ALTER TABLE "EnrollmentSubmission" ADD CONSTRAINT "EnrollmentSubmission_evidenceDocumentId_fkey"
      FOREIGN KEY ("evidenceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentCommunication_enrollmentId_fkey') THEN
    ALTER TABLE "EnrollmentCommunication" ADD CONSTRAINT "EnrollmentCommunication_enrollmentId_fkey"
      FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentCommunication_tenantId_fkey') THEN
    ALTER TABLE "EnrollmentCommunication" ADD CONSTRAINT "EnrollmentCommunication_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentCommunication_submissionId_fkey') THEN
    ALTER TABLE "EnrollmentCommunication" ADD CONSTRAINT "EnrollmentCommunication_submissionId_fkey"
      FOREIGN KEY ("submissionId") REFERENCES "EnrollmentSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentCommunication_evidenceDocumentId_fkey') THEN
    ALTER TABLE "EnrollmentCommunication" ADD CONSTRAINT "EnrollmentCommunication_evidenceDocumentId_fkey"
      FOREIGN KEY ("evidenceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EnrollmentCommunication_createdById_fkey') THEN
    ALTER TABLE "EnrollmentCommunication" ADD CONSTRAINT "EnrollmentCommunication_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Task_submissionId_fkey') THEN
    ALTER TABLE "Task" ADD CONSTRAINT "Task_submissionId_fkey"
      FOREIGN KEY ("submissionId") REFERENCES "EnrollmentSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Task_communicationId_fkey') THEN
    ALTER TABLE "Task" ADD CONSTRAINT "Task_communicationId_fkey"
      FOREIGN KEY ("communicationId") REFERENCES "EnrollmentCommunication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
