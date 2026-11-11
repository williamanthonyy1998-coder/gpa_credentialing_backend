-- Additive enrollment activity chat, approval details, and document linkage.
-- Safe nullable columns and new tables. No row deletes. No resets.
-- Saving approval details does not change enrollment status by itself.

ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "revalidationAt" TIMESTAMP(3);

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "enrollmentId" TEXT;

CREATE TABLE IF NOT EXISTS "EnrollmentActivity" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "activityType" TEXT NOT NULL DEFAULT 'MESSAGE',
    "metadata" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnrollmentActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EnrollmentActivityAttachment" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnrollmentActivityAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EnrollmentActivityRead" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnrollmentActivityRead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EnrollmentApprovalDetails" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "payerEnrollmentId" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "revalidationAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EnrollmentApprovalDetails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnrollmentApprovalDetails_enrollmentId_key"
  ON "EnrollmentApprovalDetails"("enrollmentId");

CREATE UNIQUE INDEX IF NOT EXISTS "EnrollmentActivityAttachment_activityId_documentId_key"
  ON "EnrollmentActivityAttachment"("activityId", "documentId");

CREATE UNIQUE INDEX IF NOT EXISTS "EnrollmentActivityRead_activityId_userId_key"
  ON "EnrollmentActivityRead"("activityId", "userId");

CREATE INDEX IF NOT EXISTS "EnrollmentActivity_enrollmentId_createdAt_idx"
  ON "EnrollmentActivity"("enrollmentId", "createdAt");

CREATE INDEX IF NOT EXISTS "EnrollmentActivity_enrollmentId_deletedAt_idx"
  ON "EnrollmentActivity"("enrollmentId", "deletedAt");

CREATE INDEX IF NOT EXISTS "EnrollmentActivity_authorId_createdAt_idx"
  ON "EnrollmentActivity"("authorId", "createdAt");

CREATE INDEX IF NOT EXISTS "EnrollmentActivityAttachment_documentId_idx"
  ON "EnrollmentActivityAttachment"("documentId");

CREATE INDEX IF NOT EXISTS "EnrollmentActivityRead_userId_readAt_idx"
  ON "EnrollmentActivityRead"("userId", "readAt");

CREATE INDEX IF NOT EXISTS "Document_enrollmentId_idx"
  ON "Document"("enrollmentId");

DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentActivity" ADD CONSTRAINT "EnrollmentActivity_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentActivity" ADD CONSTRAINT "EnrollmentActivity_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentActivityAttachment" ADD CONSTRAINT "EnrollmentActivityAttachment_activityId_fkey"
    FOREIGN KEY ("activityId") REFERENCES "EnrollmentActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentActivityAttachment" ADD CONSTRAINT "EnrollmentActivityAttachment_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentActivityRead" ADD CONSTRAINT "EnrollmentActivityRead_activityId_fkey"
    FOREIGN KEY ("activityId") REFERENCES "EnrollmentActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentActivityRead" ADD CONSTRAINT "EnrollmentActivityRead_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentApprovalDetails" ADD CONSTRAINT "EnrollmentApprovalDetails_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentApprovalDetails" ADD CONSTRAINT "EnrollmentApprovalDetails_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EnrollmentApprovalDetails" ADD CONSTRAINT "EnrollmentApprovalDetails_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
