import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
try {
  const enums = await p.$queryRawUnsafe(
    `SELECT e.enumlabel AS v
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = 'ExternalIntegrationStatus'
     ORDER BY e.enumsortorder`
  );
  console.log('ExternalIntegrationStatus values:', enums.map((r) => r.v).join(', '));

  const def = await p.$queryRawUnsafe(
    `SELECT column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'Document' AND column_name = 'securityStatus'`
  );
  console.log('Document.securityStatus default:', def);

  const migrations = await p.$queryRawUnsafe(
    `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 5`
  );
  console.log('Recent migrations:', migrations);
} finally {
  await p.$disconnect();
}
