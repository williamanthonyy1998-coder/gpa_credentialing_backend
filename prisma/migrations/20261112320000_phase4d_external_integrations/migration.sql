-- Phase 4D — External integration registry, provider authorization, operation history (additive).

CREATE TYPE "ExternalIntegrationType" AS ENUM ('CAQH', 'PECOS', 'AVAILITY', 'PAYER_PORTAL', 'OTHER');
CREATE TYPE "ExternalIntegrationStatus" AS ENUM (
  'NOT_CONFIGURED', 'PENDING_APPROVAL', 'PENDING_CREDENTIALS', 'READY_FOR_CONNECTION_TEST',
  'CONNECTED', 'DEGRADED', 'DISCONNECTED', 'DISABLED', 'NOT_SUPPORTED', 'MANUAL_ONLY'
);
CREATE TYPE "ExternalConnectionMode" AS ENUM (
  'OFFICIAL_API', 'AUTHORIZED_PARTNER', 'MANUAL_PORTAL', 'FILE_IMPORT_EXPORT', 'NOT_AVAILABLE'
);
CREATE TYPE "ProviderIntegrationAuthStatus" AS ENUM (
  'NOT_REQUESTED', 'REQUESTED', 'GRANTED', 'EXPIRED', 'REVOKED', 'REJECTED'
);
CREATE TYPE "ExternalOperationStatus" AS ENUM (
  'QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NOT_SUPPORTED', 'REQUIRES_MANUAL_ACTION'
);

CREATE TABLE "ExternalIntegration" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "integrationType" "ExternalIntegrationType" NOT NULL,
  "displayName" TEXT NOT NULL,
  "systemName" TEXT NOT NULL,
  "status" "ExternalIntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "connectionMode" "ExternalConnectionMode" NOT NULL DEFAULT 'NOT_AVAILABLE',
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "credentialSecretRef" TEXT,
  "credentialConfiguredAt" TIMESTAMP(3),
  "credentialConfiguredById" TEXT,
  "feasibilityNotes" TEXT,
  "officialSourceUrl" TEXT,
  "lastVerifiedAt" TIMESTAMP(3),
  "lastTestedAt" TIMESTAMP(3),
  "lastSuccessfulSyncAt" TIMESTAMP(3),
  "lastErrorAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorSummary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalIntegration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderIntegrationAuthorization" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "authorizationType" TEXT NOT NULL DEFAULT 'DELEGATION',
  "status" "ProviderIntegrationAuthStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
  "grantedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "grantedById" TEXT,
  "evidenceDocumentId" TEXT,
  "externalReference" TEXT,
  "scope" JSONB NOT NULL DEFAULT '[]',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderIntegrationAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderIntegrationAuthorizationEvent" (
  "id" TEXT NOT NULL,
  "authorizationId" TEXT NOT NULL,
  "fromStatus" "ProviderIntegrationAuthStatus",
  "toStatus" "ProviderIntegrationAuthStatus" NOT NULL,
  "actorId" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderIntegrationAuthorizationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalIntegrationOperation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "providerId" TEXT,
  "enrollmentId" TEXT,
  "operationType" TEXT NOT NULL,
  "operationStatus" "ExternalOperationStatus" NOT NULL DEFAULT 'QUEUED',
  "externalReference" TEXT,
  "idempotencyKey" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "initiatedById" TEXT,
  "safeErrorCode" TEXT,
  "safeErrorSummary" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalIntegrationOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExternalIntegration_tenantId_integrationType_idx" ON "ExternalIntegration"("tenantId", "integrationType");
CREATE INDEX "ExternalIntegration_integrationType_status_idx" ON "ExternalIntegration"("integrationType", "status");
CREATE INDEX "ExternalIntegration_status_idx" ON "ExternalIntegration"("status");
CREATE INDEX "ExternalIntegration_credentialConfiguredById_idx" ON "ExternalIntegration"("credentialConfiguredById");

CREATE INDEX "ProviderIntegrationAuthorization_tenantId_providerId_idx" ON "ProviderIntegrationAuthorization"("tenantId", "providerId");
CREATE INDEX "ProviderIntegrationAuthorization_providerId_integrationId_idx" ON "ProviderIntegrationAuthorization"("providerId", "integrationId");
CREATE INDEX "ProviderIntegrationAuthorization_integrationId_status_idx" ON "ProviderIntegrationAuthorization"("integrationId", "status");
CREATE INDEX "ProviderIntegrationAuthorization_status_expiresAt_idx" ON "ProviderIntegrationAuthorization"("status", "expiresAt");
CREATE INDEX "ProviderIntegrationAuthorization_evidenceDocumentId_idx" ON "ProviderIntegrationAuthorization"("evidenceDocumentId");

CREATE INDEX "ProviderIntegrationAuthorizationEvent_authorizationId_createdAt_idx" ON "ProviderIntegrationAuthorizationEvent"("authorizationId", "createdAt");

CREATE UNIQUE INDEX "ExternalIntegrationOperation_tenantId_idempotencyKey_key" ON "ExternalIntegrationOperation"("tenantId", "idempotencyKey");
CREATE INDEX "ExternalIntegrationOperation_tenantId_integrationId_idx" ON "ExternalIntegrationOperation"("tenantId", "integrationId");
CREATE INDEX "ExternalIntegrationOperation_integrationId_operationStatus_idx" ON "ExternalIntegrationOperation"("integrationId", "operationStatus");
CREATE INDEX "ExternalIntegrationOperation_providerId_createdAt_idx" ON "ExternalIntegrationOperation"("providerId", "createdAt");
CREATE INDEX "ExternalIntegrationOperation_enrollmentId_createdAt_idx" ON "ExternalIntegrationOperation"("enrollmentId", "createdAt");
CREATE INDEX "ExternalIntegrationOperation_operationStatus_createdAt_idx" ON "ExternalIntegrationOperation"("operationStatus", "createdAt");

ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_credentialConfiguredById_fkey"
  FOREIGN KEY ("credentialConfiguredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProviderIntegrationAuthorization" ADD CONSTRAINT "ProviderIntegrationAuthorization_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderIntegrationAuthorization" ADD CONSTRAINT "ProviderIntegrationAuthorization_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderIntegrationAuthorization" ADD CONSTRAINT "ProviderIntegrationAuthorization_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "ExternalIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderIntegrationAuthorization" ADD CONSTRAINT "ProviderIntegrationAuthorization_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProviderIntegrationAuthorization" ADD CONSTRAINT "ProviderIntegrationAuthorization_evidenceDocumentId_fkey"
  FOREIGN KEY ("evidenceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProviderIntegrationAuthorizationEvent" ADD CONSTRAINT "ProviderIntegrationAuthorizationEvent_authorizationId_fkey"
  FOREIGN KEY ("authorizationId") REFERENCES "ProviderIntegrationAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderIntegrationAuthorizationEvent" ADD CONSTRAINT "ProviderIntegrationAuthorizationEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExternalIntegrationOperation" ADD CONSTRAINT "ExternalIntegrationOperation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalIntegrationOperation" ADD CONSTRAINT "ExternalIntegrationOperation_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "ExternalIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalIntegrationOperation" ADD CONSTRAINT "ExternalIntegrationOperation_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalIntegrationOperation" ADD CONSTRAINT "ExternalIntegrationOperation_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "EnrollmentApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalIntegrationOperation" ADD CONSTRAINT "ExternalIntegrationOperation_initiatedById_fkey"
  FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
