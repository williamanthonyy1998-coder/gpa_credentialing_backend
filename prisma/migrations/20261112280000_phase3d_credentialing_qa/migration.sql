-- Phase 3D: Credentialing QA scan history. Additive only.
-- Reuses DataQualityIssue for findings (fingerprint dedupe already present).

CREATE TABLE IF NOT EXISTS "CredentialingQaScan" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "startedById" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "recordsInspected" INTEGER NOT NULL DEFAULT 0,
  "providersInspected" INTEGER NOT NULL DEFAULT 0,
  "findingsCreated" INTEGER NOT NULL DEFAULT 0,
  "findingsUpdated" INTEGER NOT NULL DEFAULT 0,
  "findingsBySeverity" JSONB,
  "summary" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CredentialingQaScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CredentialingQaScan_tenantId_startedAt_idx"
  ON "CredentialingQaScan"("tenantId", "startedAt");

CREATE INDEX IF NOT EXISTS "CredentialingQaScan_tenantId_status_idx"
  ON "CredentialingQaScan"("tenantId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CredentialingQaScan_tenantId_fkey'
  ) THEN
    ALTER TABLE "CredentialingQaScan"
      ADD CONSTRAINT "CredentialingQaScan_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
