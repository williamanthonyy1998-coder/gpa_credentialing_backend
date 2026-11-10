-- Additive workflow / intake / HR / notifications migration.
-- Backup PostgreSQL before apply. Does not drop tables or delete business rows.

-- User schedule / timezone
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timezone" TEXT DEFAULT 'UTC';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "workSchedule" JSONB;

-- Optional org membership for tenant scoping (empty = global staff)
CREATE TABLE IF NOT EXISTS "UserOrganization" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserOrganization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UserOrganization_userId_organizationId_key" ON "UserOrganization"("userId", "organizationId");
CREATE INDEX IF NOT EXISTS "UserOrganization_organizationId_idx" ON "UserOrganization"("organizationId");
DO $$ BEGIN
  ALTER TABLE "UserOrganization" ADD CONSTRAINT "UserOrganization_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "UserOrganization" ADD CONSTRAINT "UserOrganization_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Task entity links
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "practiceId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "facilityId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
CREATE INDEX IF NOT EXISTS "Task_organizationId_status_idx" ON "Task"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "Task_assignedToId_status_idx" ON "Task"("assignedToId", "status");
DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_practiceId_fkey"
    FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_facilityId_fkey"
    FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Task" ADD CONSTRAINT "Task_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "TaskComment" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "authorId" TEXT,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TaskComment_taskId_createdAt_idx" ON "TaskComment"("taskId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Intake
DO $$ BEGIN CREATE TYPE "IntakeStatus" AS ENUM ('DRAFT','SENT','IN_PROGRESS','SUBMITTED','UNDER_REVIEW','CONVERTED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "IntakeKind" AS ENUM ('PROVIDER','PRACTICE','FACILITY','ORGANIZATION','COMBINED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "IntakeRequest" (
  "id" TEXT NOT NULL,
  "referenceNo" TEXT NOT NULL,
  "kind" "IntakeKind" NOT NULL DEFAULT 'PROVIDER',
  "status" "IntakeStatus" NOT NULL DEFAULT 'DRAFT',
  "organizationId" TEXT,
  "assignedToId" TEXT,
  "createdById" TEXT,
  "contactName" TEXT,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "payload" JSONB,
  "missingFields" JSONB,
  "convertedProviderId" TEXT,
  "convertedPracticeId" TEXT,
  "convertedFacilityId" TEXT,
  "convertedOrganizationId" TEXT,
  "sentAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "convertedAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntakeRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IntakeRequest_referenceNo_key" ON "IntakeRequest"("referenceNo");
CREATE INDEX IF NOT EXISTS "IntakeRequest_status_createdAt_idx" ON "IntakeRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "IntakeRequest_organizationId_status_idx" ON "IntakeRequest"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "IntakeRequest_assignedToId_status_idx" ON "IntakeRequest"("assignedToId", "status");
DO $$ BEGIN
  ALTER TABLE "IntakeRequest" ADD CONSTRAINT "IntakeRequest_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "IntakeRequest" ADD CONSTRAINT "IntakeRequest_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "IntakeRequest" ADD CONSTRAINT "IntakeRequest_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "IntakeEvent" (
  "id" TEXT NOT NULL,
  "intakeId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorId" TEXT,
  "detail" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntakeEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "IntakeEvent_intakeId_createdAt_idx" ON "IntakeEvent"("intakeId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "IntakeEvent" ADD CONSTRAINT "IntakeEvent_intakeId_fkey"
    FOREIGN KEY ("intakeId") REFERENCES "IntakeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Leave
DO $$ BEGIN CREATE TYPE "LeaveStatus" AS ENUM ('PENDING','APPROVED','REJECTED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "LeaveType" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "paid" BOOLEAN NOT NULL DEFAULT true,
  "annualDays" DECIMAL(5,2),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveType_name_key" ON "LeaveType"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveType_code_key" ON "LeaveType"("code");

CREATE TABLE IF NOT EXISTS "LeaveRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "leaveTypeId" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LeaveRequest_userId_startDate_idx" ON "LeaveRequest"("userId", "startDate");
CREATE INDEX IF NOT EXISTS "LeaveRequest_status_startDate_idx" ON "LeaveRequest"("status", "startDate");
DO $$ BEGIN
  ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_leaveTypeId_fkey"
    FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "LeaveBalance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "leaveTypeId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "entitled" DECIMAL(5,2) NOT NULL,
  "used" DECIMAL(5,2) NOT NULL DEFAULT 0,
  CONSTRAINT "LeaveBalance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveBalance_userId_leaveTypeId_year_key" ON "LeaveBalance"("userId", "leaveTypeId", "year");
CREATE INDEX IF NOT EXISTS "LeaveBalance_userId_year_idx" ON "LeaveBalance"("userId", "year");
DO $$ BEGIN
  ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LeaveBalance" ADD CONSTRAINT "LeaveBalance_leaveTypeId_fkey"
    FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Attendance
CREATE TABLE IF NOT EXISTS "AttendanceRecord" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workDate" DATE NOT NULL,
  "checkInAt" TIMESTAMP(3),
  "checkOutAt" TIMESTAMP(3),
  "breakMinutes" INTEGER NOT NULL DEFAULT 0,
  "lateMinutes" INTEGER NOT NULL DEFAULT 0,
  "earlyMinutes" INTEGER NOT NULL DEFAULT 0,
  "workedMinutes" INTEGER,
  "notes" TEXT,
  "corrected" BOOLEAN NOT NULL DEFAULT false,
  "correctionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceRecord_userId_workDate_key" ON "AttendanceRecord"("userId", "workDate");
CREATE INDEX IF NOT EXISTS "AttendanceRecord_workDate_idx" ON "AttendanceRecord"("workDate");
DO $$ BEGIN
  ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Notifications
CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT,
  "type" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "href" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
DO $$ BEGIN
  ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
