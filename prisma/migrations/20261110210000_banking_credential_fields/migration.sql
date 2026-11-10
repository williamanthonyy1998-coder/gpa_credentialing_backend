-- Additive banking credential fields for Bank Letter / Voided Check documents.
-- Safe defaults/nullables. No row deletes. No resets.

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "bankTitle" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "bankRoutingNumber" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "bankAccountType" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "bankPhoneNumber" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "bankAccountHolder" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "uploadedAt" TIMESTAMP(3);
