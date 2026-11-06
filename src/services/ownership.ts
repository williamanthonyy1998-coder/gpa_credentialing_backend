import { prisma } from '../lib/prisma';

/** Ensures practice ownership percentages never exceed 100% (excluding optional ownerId on update). */
export async function assertOwnershipWithinLimit(practiceId: string, nextPercent: number, excludeOwnerId?: string) {
  const owners = await prisma.practiceOwner.findMany({
    where: { practiceId, ...(excludeOwnerId ? { id: { not: excludeOwnerId } } : {}) },
    select: { ownershipPercent: true }
  });
  const current = owners.reduce((sum, o) => sum + Number(o.ownershipPercent), 0);
  const total = current + Number(nextPercent);
  if (total > 100.0001) {
    const err: any = new Error(`Total ownership would be ${total.toFixed(2)}%. Combined ownership cannot exceed 100%.`);
    err.status = 400;
    throw err;
  }
  return total;
}

export async function ownershipSummary(practiceId: string) {
  const owners = await prisma.practiceOwner.findMany({
    where: { practiceId },
    orderBy: { createdAt: 'asc' }
  });
  const total = owners.reduce((sum, o) => sum + Number(o.ownershipPercent), 0);
  return { owners, totalPercent: total, remainingPercent: Math.max(0, 100 - total) };
}
