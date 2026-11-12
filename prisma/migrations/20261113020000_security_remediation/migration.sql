-- Security remediation (additive only)
-- C3: distinct mock success status — never reuse CONNECTED for mocks
-- H1/H2: new documents default to QUARANTINED (existing AVAILABLE rows unchanged)

ALTER TYPE "ExternalIntegrationStatus" ADD VALUE 'TEST_MOCK_SUCCEEDED';

ALTER TABLE "Document" ALTER COLUMN "securityStatus" SET DEFAULT 'QUARANTINED';
