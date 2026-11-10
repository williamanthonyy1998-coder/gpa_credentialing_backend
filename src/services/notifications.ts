import { prisma } from '../lib/prisma';

export async function notifyUser(input: {
  userId: string;
  title: string;
  body?: string;
  type?: string;
  entityType?: string;
  entityId?: string;
  href?: string;
}) {
  if (!input.userId) return null;
  return prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body || null,
      type: input.type || null,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      href: input.href || null
    }
  });
}

export async function notifyUsers(userIds: string[], payload: Omit<Parameters<typeof notifyUser>[0], 'userId'>) {
  const unique = [...new Set(userIds.filter(Boolean))];
  await Promise.all(unique.map(userId => notifyUser({ ...payload, userId })));
}
