-- Phase 2A: Client portal onboarding + secure invitations (additive)

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CLIENT_USER';

DO $$ BEGIN
  CREATE TYPE "TenantOnboardingStatus" AS ENUM (
    'NOT_STARTED',
    'INVITED',
    'ACCOUNT_ACTIVATED',
    'PROFILE_PENDING',
    'UNDER_REVIEW',
    'ACTIVE',
    'SUSPENDED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "InvitationDeliveryStatus" AS ENUM ('NOT_SENT', 'SENT', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "onboardingStatus" "TenantOnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "primaryContactName" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "primaryContactEmail" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "primaryContactPhone" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "internalNotes" TEXT;

CREATE INDEX IF NOT EXISTS "Tenant_onboardingStatus_idx" ON "Tenant"("onboardingStatus");

CREATE TABLE IF NOT EXISTS "TenantInvitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "invitedById" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "deliveryStatus" "InvitationDeliveryStatus" NOT NULL DEFAULT 'NOT_SENT',
    "deliveryError" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantInvitation_tokenHash_key" ON "TenantInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "TenantInvitation_tenantId_status_idx" ON "TenantInvitation"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "TenantInvitation_email_status_idx" ON "TenantInvitation"("email", "status");
CREATE INDEX IF NOT EXISTS "TenantInvitation_expiresAt_idx" ON "TenantInvitation"("expiresAt");

DO $$ BEGIN
  ALTER TABLE "TenantInvitation" ADD CONSTRAINT "TenantInvitation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "TenantInvitation" ADD CONSTRAINT "TenantInvitation_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
