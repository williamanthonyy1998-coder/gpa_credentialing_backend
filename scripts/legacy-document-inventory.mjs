/**
 * Read-only legacy AVAILABLE document inventory.
 *
 * Usage (against an explicitly authorized database only):
 *   DATABASE_URL=... node scripts/legacy-document-inventory.mjs
 *
 * Prints counts only — never filenames, storage keys, notes, or file contents.
 * Does not update any rows.
 *
 * Safety:
 * - Refuses credentialing_db, *_e2e, *_test, and names matching /production/i
 *   unless ALLOW_PRODUCTION_INVENTORY=1 AND CONFIRM_INVENTORY_DATABASE=<exact db name>.
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

function dbNameFromUrl(url) {
  try {
    const u = new URL(String(url).replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:'));
    return (u.pathname || '').split('/').filter(Boolean)[0] || 'unknown';
  } catch {
    return 'unparsed';
  }
}

const dbName = dbNameFromUrl(process.env.DATABASE_URL);
if (!process.env.DATABASE_URL) {
  console.error('[inventory] DATABASE_URL is required');
  process.exit(1);
}

const looksProtected =
  /^credentialing_db$/i.test(dbName)
  || /(_e2e|_test)$/i.test(dbName)
  || /^credentialing_e2e$/i.test(dbName)
  || /production/i.test(dbName);

if (looksProtected) {
  const allowed =
    process.env.ALLOW_PRODUCTION_INVENTORY === '1'
    && process.env.CONFIRM_INVENTORY_DATABASE
    && process.env.CONFIRM_INVENTORY_DATABASE === dbName;
  if (!allowed) {
    console.error(
      '[inventory] Refusing protected database name without dual authorization. '
      + 'Set ALLOW_PRODUCTION_INVENTORY=1 and CONFIRM_INVENTORY_DATABASE=<exact database name>.'
    );
    process.exit(1);
  }
}

const prisma = new PrismaClient();

try {
  const [
    total,
    available,
    quarantined,
    rejected,
    scanning,
    uploaded,
    availableWithTenant,
    availableMissingTenant,
    availableMissingOrg,
    releaseAudits
  ] = await Promise.all([
    prisma.document.count(),
    prisma.document.count({ where: { securityStatus: 'AVAILABLE' } }),
    prisma.document.count({ where: { securityStatus: 'QUARANTINED' } }),
    prisma.document.count({ where: { securityStatus: 'REJECTED' } }),
    prisma.document.count({ where: { securityStatus: 'SCANNING' } }),
    prisma.document.count({ where: { securityStatus: 'UPLOADED' } }),
    prisma.document.count({ where: { securityStatus: 'AVAILABLE', tenantId: { not: null } } }),
    prisma.document.count({ where: { securityStatus: 'AVAILABLE', tenantId: null } }),
    prisma.document.count({
      where: {
        securityStatus: 'AVAILABLE',
        organizationId: null,
        practiceId: null,
        facilityId: null,
        enrollmentId: null
      }
    }),
    prisma.auditEvent.count({
      where: {
        action: { in: ['DOCUMENT_RELEASE', 'DOCUMENT_RELEASED'] }
      }
    })
  ]);

  console.log(JSON.stringify({
    databaseName: dbName,
    counts: {
      documentsTotal: total,
      available,
      quarantined,
      rejected,
      scanning,
      uploaded,
      availableWithTenant,
      availableMissingTenant,
      availableMissingOrgLink: availableMissingOrg,
      documentReleaseAuditEvents: releaseAudits
    },
    note: 'Counts only. No filenames, storage keys, or contents were printed. Manual release audits are counted by action name; correlate carefully before trusting a row.'
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
