/**
 * Phase 5B — notification automation on top of existing Notification + email services.
 * Never pretends email was delivered. Never includes sensitive identifiers in body.
 */
import { prisma } from '../lib/prisma';
import { notifyUser } from './notifications';
import { isEmailConfigured, sendEmail, escapeHtml, appBaseUrl } from './email';
import { resolvePolicy } from './automationPolicies';
import { AutomationPolicyKind } from '@prisma/client';
import { shouldDeliverChannel } from './notificationPreferences';

const SENSITIVE = /\b(ssn|tax\s*id|routing|account\s*number|bank|password|ssn)\b/i;

export function sanitizeNotificationText(text: string) {
  const cleaned = String(text || '').replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]');
  if (SENSITIVE.test(cleaned)) {
    return cleaned.replace(SENSITIVE, '[REDACTED]');
  }
  return cleaned.slice(0, 2000);
}

export async function deliverAutomationNotification(input: {
  tenantId: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  entityType?: string;
  entityId?: string;
  href?: string;
  dedupeKey: string;
  organizationId?: string | null;
}) {
  const title = sanitizeNotificationText(input.title);
  const body = sanitizeNotificationText(input.body);

  // Tenant/org boundary: href must stay relative and not cross tenants via crafted links.
  const href = input.href && input.href.startsWith('/') ? input.href : undefined;

  const existingDelivery = await prisma.notificationDelivery.findUnique({
    where: { dedupeKey: input.dedupeKey }
  });
  if (existingDelivery && (existingDelivery.status === 'SENT' || existingDelivery.status === 'PENDING')) {
    return { notificationId: existingDelivery.notificationId, skipped: true as const };
  }

  const wantInApp = await shouldDeliverChannel({
    userId: input.userId,
    type: input.type,
    channel: 'IN_APP'
  });

  let notification: Awaited<ReturnType<typeof notifyUser>> = null;
  if (wantInApp) {
    notification = await notifyUser({
      userId: input.userId,
      title,
      body,
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      href
    });

    await prisma.notificationDelivery.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        notificationId: notification?.id || null,
        userId: input.userId,
        channel: 'IN_APP',
        status: 'SENT',
        attemptCount: 1,
        sentAt: new Date(),
        dedupeKey: input.dedupeKey,
        payloadSummary: `${input.type}:${input.entityType || ''}`
      },
      update: {
        notificationId: notification?.id || null,
        status: 'SENT',
        attemptCount: { increment: 1 },
        sentAt: new Date(),
        lastError: null
      }
    });
  }

  const policy = await resolvePolicy({
    kind: AutomationPolicyKind.NOTIFICATION,
    tenantId: input.tenantId,
    organizationId: input.organizationId
  });
  const channels = policy.config.channels || ['IN_APP'];
  const emailPref = await shouldDeliverChannel({
    userId: input.userId,
    type: input.type,
    channel: 'EMAIL'
  });
  const emailWanted = channels.includes('EMAIL') && policy.config.emailEnabled !== false && emailPref;

  if (emailWanted) {
    const emailKey = `${input.dedupeKey}:email`;
    const priorEmail = await prisma.notificationDelivery.findUnique({ where: { dedupeKey: emailKey } });
    if (!priorEmail || priorEmail.status === 'FAILED' || priorEmail.status === 'RETRYING') {
      const user = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true, name: true, active: true }
      });
      if (user?.active && user.email) {
        if (!isEmailConfigured()) {
          await prisma.notificationDelivery.upsert({
            where: { dedupeKey: emailKey },
            create: {
              notificationId: notification?.id || null,
              userId: input.userId,
              channel: 'EMAIL',
              status: 'FAILED',
              attemptCount: 1,
              lastError: 'Email service is not configured',
              nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
              dedupeKey: emailKey,
              payloadSummary: title.slice(0, 120)
            },
            update: {
              status: 'FAILED',
              attemptCount: { increment: 1 },
              lastError: 'Email service is not configured',
              nextRetryAt: new Date(Date.now() + 60 * 60 * 1000)
            }
          });
        } else {
          const link = href ? `${appBaseUrl()}${href}` : appBaseUrl();
          const result = await sendEmail({
            to: user.email,
            subject: title,
            html: `<p>Hello ${escapeHtml(user.name)},</p><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">Open in GPA Credentialing</a></p>`
          });
          await prisma.notificationDelivery.upsert({
            where: { dedupeKey: emailKey },
            create: {
              notificationId: notification?.id || null,
              userId: input.userId,
              channel: 'EMAIL',
              status: result.ok ? 'SENT' : 'FAILED',
              attemptCount: 1,
              sentAt: result.ok ? new Date() : null,
              lastError: result.ok ? null : result.error,
              nextRetryAt: result.ok ? null : new Date(Date.now() + 60 * 60 * 1000),
              dedupeKey: emailKey,
              payloadSummary: title.slice(0, 120)
            },
            update: {
              status: result.ok ? 'SENT' : 'FAILED',
              attemptCount: { increment: 1 },
              sentAt: result.ok ? new Date() : undefined,
              lastError: result.ok ? null : result.error,
              nextRetryAt: result.ok ? null : new Date(Date.now() + 60 * 60 * 1000)
            }
          });
        }
      }
    }
  }

  return { notificationId: notification?.id || null, skipped: false as const };
}

/** Retry failed email deliveries (idempotent by dedupeKey). */
export async function retryFailedEmailDeliveries(limit = 50) {
  const due = await prisma.notificationDelivery.findMany({
    where: {
      channel: 'EMAIL',
      status: { in: ['FAILED', 'RETRYING'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
      attemptCount: { lt: 5 }
    },
    take: limit,
    orderBy: { updatedAt: 'asc' }
  });
  let sent = 0;
  let failed = 0;
  for (const row of due) {
    if (!isEmailConfigured()) {
      await prisma.notificationDelivery.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          lastError: 'Email service is not configured',
          attemptCount: { increment: 1 },
          nextRetryAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
        }
      });
      failed += 1;
      continue;
    }
    const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true, name: true, active: true } });
    if (!user?.email || !user.active) {
      failed += 1;
      continue;
    }
    const result = await sendEmail({
      to: user.email,
      subject: row.payloadSummary || 'GPA Credentialing notification',
      html: `<p>Hello ${escapeHtml(user.name)},</p><p>You have an update in GPA Credentialing. Please sign in to review.</p>`
    });
    await prisma.notificationDelivery.update({
      where: { id: row.id },
      data: {
        status: result.ok ? 'SENT' : 'RETRYING',
        attemptCount: { increment: 1 },
        sentAt: result.ok ? new Date() : undefined,
        lastError: result.ok ? null : result.error,
        nextRetryAt: result.ok ? null : new Date(Date.now() + 2 * 60 * 60 * 1000)
      }
    });
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { processed: due.length, sent, failed };
}
