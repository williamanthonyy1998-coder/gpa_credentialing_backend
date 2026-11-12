import { prisma } from '../src/lib/prisma';

async function main() {
  const orgsUnmapped = await prisma.organization.count({ where: { tenantId: null } });
  const docsUnmapped = await prisma.document.count({ where: { tenantId: null } });
  const enrollUnmapped = await prisma.enrollmentApplication.count({ where: { tenantId: null } });
  const casesUnmapped = await prisma.credentialingCase.count({ where: { tenantId: null } });
  const providersWithoutTenantLink = await prisma.provider.count({ where: { tenantLinks: { none: {} } } });
  console.log({ orgsUnmapped, docsUnmapped, enrollUnmapped, casesUnmapped, providersWithoutTenantLink });
}

main().finally(() => prisma.$disconnect());
