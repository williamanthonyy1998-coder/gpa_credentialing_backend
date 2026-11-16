-- Phase 5B: Credentialing Workflow Automation (additive only)

-- Enrollment follow-up counters
ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "followUpCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EnrollmentApplication" ADD COLUMN IF NOT EXISTS "followUpStatus" TEXT;

-- Task assignment history
CREATE TABLE IF NOT EXISTS "TaskAssignmentEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "changedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskAssignmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TaskAssignmentEvent_taskId_createdAt_idx" ON "TaskAssignmentEvent"("taskId", "createdAt");
CREATE INDEX IF NOT EXISTS "TaskAssignmentEvent_toUserId_createdAt_idx" ON "TaskAssignmentEvent"("toUserId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "TaskAssignmentEvent" ADD CONSTRAINT "TaskAssignmentEvent_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Notification delivery ledger
CREATE TABLE IF NOT EXISTS "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "payloadSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationDelivery_dedupeKey_key" ON "NotificationDelivery"("dedupeKey");
CREATE INDEX IF NOT EXISTS "NotificationDelivery_status_nextRetryAt_idx" ON "NotificationDelivery"("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");

DO $$ BEGIN
  ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enums
DO $$ BEGIN
  CREATE TYPE "AutomationPolicyKind" AS ENUM ('FOLLOW_UP_INTERVAL', 'ESCALATION', 'SLA', 'EXPIRY_ALERT', 'TASK_ASSIGNMENT', 'NOTIFICATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkflowSlaStatus" AS ENUM ('NOT_STARTED', 'WITHIN_SLA', 'DUE_SOON', 'AT_RISK', 'OVERDUE', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AutomationPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "organizationId" TEXT,
    "payerId" TEXT,
    "kind" "AutomationPolicyKind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AutomationPolicy_tenantId_kind_enabled_idx" ON "AutomationPolicy"("tenantId", "kind", "enabled");
CREATE INDEX IF NOT EXISTS "AutomationPolicy_organizationId_kind_enabled_idx" ON "AutomationPolicy"("organizationId", "kind", "enabled");
CREATE INDEX IF NOT EXISTS "AutomationPolicy_payerId_kind_enabled_idx" ON "AutomationPolicy"("payerId", "kind", "enabled");
CREATE INDEX IF NOT EXISTS "AutomationPolicy_kind_enabled_idx" ON "AutomationPolicy"("kind", "enabled");

DO $$ BEGIN
  ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "AutomationPolicy_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "AutomationPolicy_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "AutomationPolicy_payerId_fkey"
    FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AutomationJobLock" (
    "lockKey" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationJobLock_pkey" PRIMARY KEY ("lockKey")
);

CREATE INDEX IF NOT EXISTS "AutomationJobLock_lockedUntil_idx" ON "AutomationJobLock"("lockedUntil");

CREATE TABLE IF NOT EXISTS "AutomationJobRun" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "tenantId" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "triggeredBy" TEXT NOT NULL,
    "lockKey" TEXT,
    "result" JSONB,
    "errorMessage" TEXT,
    CONSTRAINT "AutomationJobRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AutomationJobRun_jobType_startedAt_idx" ON "AutomationJobRun"("jobType", "startedAt");
CREATE INDEX IF NOT EXISTS "AutomationJobRun_tenantId_startedAt_idx" ON "AutomationJobRun"("tenantId", "startedAt");
CREATE INDEX IF NOT EXISTS "AutomationJobRun_status_startedAt_idx" ON "AutomationJobRun"("status", "startedAt");

DO $$ BEGIN
  ALTER TABLE "AutomationJobRun" ADD CONSTRAINT "AutomationJobRun_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "WorkflowSlaRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "policyId" TEXT,
    "applicationCreatedAt" TIMESTAMP(3),
    "submissionDate" TIMESTAMP(3),
    "acknowledgementDate" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "expectedCompletionAt" TIMESTAMP(3),
    "actualCompletionAt" TIMESTAMP(3),
    "elapsedDays" INTEGER,
    "businessDaysElapsed" INTEGER,
    "daysRemaining" INTEGER,
    "overdueDays" INTEGER,
    "slaStatus" "WorkflowSlaStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "statusHistory" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowSlaRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowSlaRecord_entityType_entityId_key" ON "WorkflowSlaRecord"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "WorkflowSlaRecord_tenantId_slaStatus_idx" ON "WorkflowSlaRecord"("tenantId", "slaStatus");
CREATE INDEX IF NOT EXISTS "WorkflowSlaRecord_organizationId_slaStatus_idx" ON "WorkflowSlaRecord"("organizationId", "slaStatus");
CREATE INDEX IF NOT EXISTS "WorkflowSlaRecord_slaStatus_expectedCompletionAt_idx" ON "WorkflowSlaRecord"("slaStatus", "expectedCompletionAt");
CREATE INDEX IF NOT EXISTS "WorkflowSlaRecord_expectedCompletionAt_idx" ON "WorkflowSlaRecord"("expectedCompletionAt");

DO $$ BEGIN
  ALTER TABLE "WorkflowSlaRecord" ADD CONSTRAINT "WorkflowSlaRecord_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "WorkflowSlaRecord" ADD CONSTRAINT "WorkflowSlaRecord_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "EscalationRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedEmployeeId" TEXT,
    "responsibleManagerId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNotes" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EscalationRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EscalationRecord_dedupeKey_key" ON "EscalationRecord"("dedupeKey");
CREATE INDEX IF NOT EXISTS "EscalationRecord_tenantId_status_level_idx" ON "EscalationRecord"("tenantId", "status", "level");
CREATE INDEX IF NOT EXISTS "EscalationRecord_organizationId_status_idx" ON "EscalationRecord"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "EscalationRecord_entityType_entityId_status_idx" ON "EscalationRecord"("entityType", "entityId", "status");
CREATE INDEX IF NOT EXISTS "EscalationRecord_assignedEmployeeId_status_idx" ON "EscalationRecord"("assignedEmployeeId", "status");

DO $$ BEGIN
  ALTER TABLE "EscalationRecord" ADD CONSTRAINT "EscalationRecord_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EscalationRecord" ADD CONSTRAINT "EscalationRecord_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AutomationAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT,
    "alertType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "thresholdKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notifiedUserIds" JSONB,
    "taskId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutomationAlert_dedupeKey_key" ON "AutomationAlert"("dedupeKey");
CREATE INDEX IF NOT EXISTS "AutomationAlert_tenantId_alertType_status_idx" ON "AutomationAlert"("tenantId", "alertType", "status");
CREATE INDEX IF NOT EXISTS "AutomationAlert_organizationId_status_idx" ON "AutomationAlert"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "AutomationAlert_entityType_entityId_idx" ON "AutomationAlert"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "AutomationAlert_status_createdAt_idx" ON "AutomationAlert"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "AutomationAlert" ADD CONSTRAINT "AutomationAlert_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AutomationAlert" ADD CONSTRAINT "AutomationAlert_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
