/**
 * Phase 5C — per-user notification preferences.
 * SYSTEM category cannot disable in-app delivery.
 */
import { prisma } from '../lib/prisma';

export const NOTIFICATION_CATEGORIES = [
  'FOLLOW_UP',
  'TASK_ASSIGNMENT',
  'TASK_OVERDUE',
  'ESCALATION',
  'SLA_WARNING',
  'CREDENTIAL_EXPIRY',
  'REVALIDATION',
  'SYSTEM'
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Categories that always deliver in-app regardless of preference. */
export const MANDATORY_IN_APP_CATEGORIES: NotificationCategory[] = ['SYSTEM'];

export const DEFAULT_PREFERENCES: Record<NotificationCategory, { channelInApp: boolean; channelEmail: boolean }> = {
  FOLLOW_UP: { channelInApp: true, channelEmail: true },
  TASK_ASSIGNMENT: { channelInApp: true, channelEmail: true },
  TASK_OVERDUE: { channelInApp: true, channelEmail: true },
  ESCALATION: { channelInApp: true, channelEmail: true },
  SLA_WARNING: { channelInApp: true, channelEmail: true },
  CREDENTIAL_EXPIRY: { channelInApp: true, channelEmail: true },
  REVALIDATION: { channelInApp: true, channelEmail: true },
  SYSTEM: { channelInApp: true, channelEmail: true }
};

export function mapNotificationTypeToCategory(type?: string | null): NotificationCategory {
  const t = String(type || '').toUpperCase();
  if (t.includes('FOLLOW')) return 'FOLLOW_UP';
  if (t.includes('TASK_ASSIGN') || t === 'TASK' || t === 'TASK_ASSIGNED') return 'TASK_ASSIGNMENT';
  if (t.includes('TASK_ESCAL') || t.includes('OVERDUE')) return 'TASK_OVERDUE';
  if (t.includes('ESCALAT')) return 'ESCALATION';
  if (t.includes('SLA')) return 'SLA_WARNING';
  if (t.includes('EXPIR') || t.includes('LICENSE') || t.includes('CREDENTIAL')) return 'CREDENTIAL_EXPIRY';
  if (t.includes('REVALID')) return 'REVALIDATION';
  if (t.includes('SYSTEM') || t.includes('SECURITY') || t.includes('PASSWORD') || t.includes('INVITE')) return 'SYSTEM';
  return 'SYSTEM';
}

export async function getEffectivePreferences(userId: string) {
  const rows = await prisma.notificationPreference.findMany({ where: { userId } });
  const byCat = new Map(rows.map((r) => [r.category, r]));
  return NOTIFICATION_CATEGORIES.map((category) => {
    const row = byCat.get(category);
    const defaults = DEFAULT_PREFERENCES[category];
    let channelInApp = row?.channelInApp ?? defaults.channelInApp;
    let channelEmail = row?.channelEmail ?? defaults.channelEmail;
    if (MANDATORY_IN_APP_CATEGORIES.includes(category)) channelInApp = true;
    return {
      category,
      channelInApp,
      channelEmail,
      mandatoryInApp: MANDATORY_IN_APP_CATEGORIES.includes(category),
      id: row?.id || null
    };
  });
}

export async function upsertPreferences(input: {
  userId: string;
  actorId: string;
  items: Array<{ category: string; channelInApp?: boolean; channelEmail?: boolean }>;
}) {
  if (input.userId !== input.actorId) {
    const err: any = new Error('Cannot modify another user\'s notification preferences');
    err.status = 403;
    throw err;
  }
  const results = [];
  for (const item of input.items) {
    if (!NOTIFICATION_CATEGORIES.includes(item.category as NotificationCategory)) {
      const err: any = new Error(`Invalid category: ${item.category}`);
      err.status = 400;
      throw err;
    }
    const category = item.category as NotificationCategory;
    const defaults = DEFAULT_PREFERENCES[category];
    let channelInApp = item.channelInApp ?? defaults.channelInApp;
    let channelEmail = item.channelEmail ?? defaults.channelEmail;
    if (MANDATORY_IN_APP_CATEGORIES.includes(category)) channelInApp = true;

    const row = await prisma.notificationPreference.upsert({
      where: { userId_category: { userId: input.userId, category } },
      create: {
        userId: input.userId,
        category,
        channelInApp,
        channelEmail
      },
      update: { channelInApp, channelEmail }
    });
    results.push(row);
  }
  return getEffectivePreferences(input.userId);
}

export async function shouldDeliverChannel(input: {
  userId: string;
  type?: string | null;
  channel: 'IN_APP' | 'EMAIL';
}) {
  const category = mapNotificationTypeToCategory(input.type);
  const prefs = await getEffectivePreferences(input.userId);
  const pref = prefs.find((p) => p.category === category)!;
  if (input.channel === 'IN_APP') return pref.channelInApp;
  return pref.channelEmail;
}
