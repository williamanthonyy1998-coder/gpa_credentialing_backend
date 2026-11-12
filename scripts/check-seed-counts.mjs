import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const r = {
  payers: await prisma.payer.count(),
  specialtiesActive: await prisma.specialty.count({ where: { status: 'ACTIVE' } }),
  usStatesTX: await prisma.usState.count({ where: { abbreviation: 'TX' } }),
  plansActive: await prisma.payerPlan.count({ where: { status: 'ACTIVE' } }),
  licenseTypes: await prisma.licenseType.count({ where: { status: 'ACTIVE' } })
};
console.log(r);
await prisma.$disconnect();
