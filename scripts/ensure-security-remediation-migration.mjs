/**
 * Idempotent apply for 20261113020000_security_remediation when migrate deploy
 * does not pick up the additive SQL (enum ADD VALUE / default change).
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const MIGRATION = '20261113020000_security_remediation';

async function applyTo(url, label) {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const applied = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 LIMIT 1`,
      MIGRATION
    );
    const alreadyTracked = Array.isArray(applied) && applied.length > 0;

    const enums = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
       WHERE t.typname = 'ExternalIntegrationStatus' AND e.enumlabel = 'TEST_MOCK_SUCCEEDED'`
    );
    if (!Array.isArray(enums) || enums.length === 0) {
      await prisma.$executeRawUnsafe(
        `ALTER TYPE "ExternalIntegrationStatus" ADD VALUE 'TEST_MOCK_SUCCEEDED'`
      );
      console.log(`[${label}] Added ExternalIntegrationStatus.TEST_MOCK_SUCCEEDED`);
    } else {
      console.log(`[${label}] Enum TEST_MOCK_SUCCEEDED already present`);
    }

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Document" ALTER COLUMN "securityStatus" SET DEFAULT 'QUARANTINED'::"DocumentSecurityStatus"`
    );
    console.log(`[${label}] Document.securityStatus default set to QUARANTINED`);

    if (!alreadyTracked) {
      const checksum = crypto.createHash('sha256').update(MIGRATION).digest('hex');
      await prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
        crypto.randomUUID(),
        checksum,
        MIGRATION
      );
      console.log(`[${label}] Recorded migration in _prisma_migrations`);
    } else {
      console.log(`[${label}] Migration already recorded`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const mainUrl = process.env.DATABASE_URL;
  if (!mainUrl) throw new Error('DATABASE_URL required');
  await applyTo(mainUrl, 'main');

  const e2eUrl = process.env.E2E_DATABASE_URL;
  if (e2eUrl) {
    await applyTo(e2eUrl, 'e2e');
  } else {
    console.log('[e2e] Skipped (set E2E_DATABASE_URL to apply)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
