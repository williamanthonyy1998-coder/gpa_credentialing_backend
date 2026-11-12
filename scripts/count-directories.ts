import { prisma } from '../src/lib/prisma';

async function main() {
  console.log({
    usStates: await prisma.usState.count(),
    specialties: await prisma.specialty.count(),
    licenseTypes: await prisma.licenseType.count(),
    degreeTypes: await prisma.degreeType.count(),
    credentialCategories: await prisma.credentialCategory.count(),
    payerRequirements: await prisma.payerRequirement.count(),
    providersWithSpecialtyFk: await prisma.provider.count({ where: { primarySpecialtyId: { not: null } } })
  });
}

main().finally(() => prisma.$disconnect());
