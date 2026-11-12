-- Phase 0A: multi-tenant foundation (additive only).
-- Introduces Tenant + TenantMembership. Organization.tenantId is nullable.
-- No row deletes. No resets. Existing Organization rows remain unassigned (NULL)
-- until an explicit, deterministic mapping is applied in a later phase.
-- Organization is NOT a Tenant.

DO $$ BEGIN
  CREATE TYPE "TenantRole" AS ENUM (
    'TENANT_ADMIN',
    'CREDENTIALING_MANAGER',
    'CREDENTIALING_SPECIALIST',
    'ENROLLMENT_SPECIALIST',
    'APPROVER',
    'AUDITOR',
    'READ_ONLY'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TenantMembershipStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX IF NOT EXISTS "Tenant_status_idx" ON "Tenant"("status");

CREATE TABLE IF NOT EXISTS "TenantMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "status" "TenantMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantMembership_userId_tenantId_key" ON "TenantMembership"("userId", "tenantId");
CREATE INDEX IF NOT EXISTS "TenantMembership_tenantId_idx" ON "TenantMembership"("tenantId");
CREATE INDEX IF NOT EXISTS "TenantMembership_userId_idx" ON "TenantMembership"("userId");
CREATE INDEX IF NOT EXISTS "TenantMembership_tenantId_status_idx" ON "TenantMembership"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "TenantMembership_userId_status_idx" ON "TenantMembership"("userId", "status");

DO $$ BEGIN
  ALTER TABLE "TenantMembership"
    ADD CONSTRAINT "TenantMembership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "TenantMembership"
    ADD CONSTRAINT "TenantMembership_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Organization_tenantId_idx" ON "Organization"("tenantId");
CREATE INDEX IF NOT EXISTS "Organization_tenantId_status_idx" ON "Organization"("tenantId", "status");

DO $$ BEGIN
  ALTER TABLE "Organization"
    ADD CONSTRAINT "Organization_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
