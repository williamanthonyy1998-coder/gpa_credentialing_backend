-- Phase 2B: External provider intake invitations, extended intake lifecycle, document quarantine.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'EXTERNAL_PROVIDER';

ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'INVITED';
ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';
ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'RESUBMITTED';
ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "IntakeStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

DO $$ BEGIN
  CREATE TYPE "DocumentSecurityStatus" AS ENUM ('UPLOADED', 'QUARANTINED', 'SCANNING', 'AVAILABLE', 'REJECTED', 'DELETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ProviderIdentityMatch" AS ENUM ('NEW', 'MATCHED', 'AMBIGUOUS', 'NONE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "providerUserId" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "invitedEmail" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "submittedPayload" JSONB;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "reviewerComments" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "internalNotes" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "identityMatch" "ProviderIdentityMatch" NOT NULL DEFAULT 'NONE';
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "matchedProviderId" TEXT;
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "changesRequestedAt" TIMESTAMP(3);
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
ALTER TABLE "IntakeRequest" ADD COLUMN IF NOT EXISTS "lastSavedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "IntakeRequest_providerUserId_status_idx" ON "IntakeRequest"("providerUserId", "status");
CREATE INDEX IF NOT EXISTS "IntakeRequest_invitedEmail_idx" ON "IntakeRequest"("invitedEmail");

DO $$ BEGIN
  ALTER TABLE "IntakeRequest" ADD CONSTRAINT "IntakeRequest_providerUserId_fkey"
    FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Existing documents remain AVAILABLE for consumption; intake uploads set QUARANTINED explicitly.
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "securityStatus" "DocumentSecurityStatus" NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "intakeRequestId" TEXT;
CREATE INDEX IF NOT EXISTS "Document_intakeRequestId_idx" ON "Document"("intakeRequestId");
CREATE INDEX IF NOT EXISTS "Document_securityStatus_idx" ON "Document"("securityStatus");

DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_intakeRequestId_fkey"
    FOREIGN KEY ("intakeRequestId") REFERENCES "IntakeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ProviderIntakeInvitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intakeRequestId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "knownProviderId" TEXT,
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
    CONSTRAINT "ProviderIntakeInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProviderIntakeInvitation_tokenHash_key" ON "ProviderIntakeInvitation"("tokenHash");
CREATE INDEX IF NOT EXISTS "ProviderIntakeInvitation_tenantId_status_idx" ON "ProviderIntakeInvitation"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "ProviderIntakeInvitation_intakeRequestId_status_idx" ON "ProviderIntakeInvitation"("intakeRequestId", "status");
CREATE INDEX IF NOT EXISTS "ProviderIntakeInvitation_email_status_idx" ON "ProviderIntakeInvitation"("email", "status");
CREATE INDEX IF NOT EXISTS "ProviderIntakeInvitation_expiresAt_idx" ON "ProviderIntakeInvitation"("expiresAt");

DO $$ BEGIN
  ALTER TABLE "ProviderIntakeInvitation" ADD CONSTRAINT "ProviderIntakeInvitation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ProviderIntakeInvitation" ADD CONSTRAINT "ProviderIntakeInvitation_intakeRequestId_fkey"
    FOREIGN KEY ("intakeRequestId") REFERENCES "IntakeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ProviderIntakeInvitation" ADD CONSTRAINT "ProviderIntakeInvitation_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
