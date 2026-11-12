-- Phase 4E — Enrollment revalidation (separate from credential expiration). Additive only.

CREATE TYPE "EnrollmentRevalidationStatus" AS ENUM (
  'NOT_STARTED', 'UPCOMING', 'PREPARING', 'READY_FOR_INTERNAL_REVIEW', 'SUBMITTED',
  'ACKNOWLEDGED', 'ADDITIONAL_INFORMATION_REQUIRED', 'APPROVED', 'COMPLETED',
  'DENIED', 'OVERDUE', 'CANCELLED'
);

CREATE TYPE "RevalidationDueDateSource" AS ENUM (
  'CONFIRMED', 'ESTIMATED', 'MANUAL', 'PAYER_NOTICE', 'OTHER'
);

CREATE TABLE "EnrollmentRevalidation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "providerId" TEXT,
  "payerId" TEXT,
  "payerPlanId" TEXT,
  "revalidationType" TEXT NOT NULL,
  "referenceNumber" TEXT,
  "dueDate" TIMESTAMP(3),
  "dueDateSource" "RevalidationDueDateSource" NOT NULL DEFAULT 'MANUAL',
  "notificationDate" TIMESTAMP(3),
  "initiatedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "effectiveDate" TIMESTAMP(3),
  "status" "EnrollmentRevalidationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "assignedToId" TEXT,
  "source" TEXT,
  "sourceReference" TEXT,
  "notes" TEXT,
  "internalNotes" TEXT,
  "evidenceDocumentId" TEXT,
  "submissionConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "denialReason" TEXT,
  "cancellationReason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentRevalidation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnrollmentRevalidationEvent" (
  "id" TEXT NOT NULL,
  "revalidationId" TEXT NOT NULL,
  "fromStatus" "EnrollmentRevalidationStatus",
  "toStatus" "EnrollmentRevalidationStatus" NOT NULL,
  "actorId" TEXT,
  "reason" TEXT,
  "eventType" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EnrollmentRevalidationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EnrollmentRevalidation_tenantId_enrollmentId_idx" ON "EnrollmentRevalidation"("tenantId", "enrollmentId");
CREATE INDEX "EnrollmentRevalidation_tenantId_status_dueDate_idx" ON "EnrollmentRevalidation"("tenantId", "status", "dueDate");
CREATE INDEX "EnrollmentRevalidation_providerId_dueDate_idx" ON "EnrollmentRevalidation"("providerId", "dueDate");
CREATE INDEX "EnrollmentRevalidation_payerId_status_idx" ON "EnrollmentRevalidation"("payerId", "status");
CREATE INDEX "EnrollmentRevalidation_assignedToId_dueDate_idx" ON "EnrollmentRevalidation"("assignedToId", "dueDate");
CREATE INDEX "EnrollmentRevalidation_enrollmentId_revalidationType_status_idx" ON "EnrollmentRevalidation"("enrollmentId", "revalidationType", "status");
CREATE INDEX "EnrollmentRevalidation_evidenceDocumentId_idx" ON "EnrollmentRevalidation"("evidenceDocumentId");
CREATE INDEX "EnrollmentRevalidationEvent_revalidationId_createdAt_idx" ON "EnrollmentRevalidationEvent"("revalidationId", "createdAt");

ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_payerId_fkey"
  FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_payerPlanId_fkey"
  FOREIGN KEY ("payerPlanId") REFERENCES "PayerPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_evidenceDocumentId_fkey"
  FOREIGN KEY ("evidenceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidation" ADD CONSTRAINT "EnrollmentRevalidation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EnrollmentRevalidationEvent" ADD CONSTRAINT "EnrollmentRevalidationEvent_revalidationId_fkey"
  FOREIGN KEY ("revalidationId") REFERENCES "EnrollmentRevalidation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnrollmentRevalidationEvent" ADD CONSTRAINT "EnrollmentRevalidationEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
