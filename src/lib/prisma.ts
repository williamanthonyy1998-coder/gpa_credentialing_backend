import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  });

// Reuse across warm serverless invocations (Vercel) and avoid connection storms in watch mode.
if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma;
