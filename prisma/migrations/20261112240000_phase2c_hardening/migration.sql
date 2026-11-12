-- Phase 2C: submission versioning, document file revisions, intake version counter.

ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "currentSubmissionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "IntakeSubmission" (
    "id" TEXT NOT NULL,
    "intakeRequestId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewAction" TEXT,
    "reviewComments" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntakeSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntakeSubmission_intakeRequestId_version_key"
  ON "IntakeSubmission"("intakeRequestId", "version");
CREATE INDEX IF NOT EXISTS "IntakeSubmission_intakeRequestId_submittedAt_idx"
  ON "IntakeSubmission"("intakeRequestId", "submittedAt");

DO $$ BEGIN
  ALTER TABLE "IntakeSubmission" ADD CONSTRAINT "IntakeSubmission_intakeRequestId_fkey"
    FOREIGN KEY ("intakeRequestId") REFERENCES "IntakeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "DocumentFileRevision" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "storageKey" TEXT,
    "originalName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "securityStatus" "DocumentSecurityStatus" NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REPLACE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentFileRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DocumentFileRevision_documentId_createdAt_idx"
  ON "DocumentFileRevision"("documentId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "DocumentFileRevision" ADD CONSTRAINT "DocumentFileRevision_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
