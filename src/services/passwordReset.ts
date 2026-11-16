/**
 * SEC-18 — self-service password reset.
 * Stores only SHA-256(token); single-use; expiry; generic responses; session revoke on success.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { generateResetToken, hashResetToken, revokeAllSessionsForUser } from './authSession';
import { appBaseUrl, escapeHtml, isEmailConfigured, sendEmail } from './email';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ACTIVE_TOKENS_PER_USER = 3;

export async function requestPasswordReset(input: {
  email: string;
  ipAddress?: string | null;
}): Promise<void> {
  const email = String(input.email || '').trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  // Always behave the same from the caller's perspective.
  if (!user || !user.active) {
    await prisma.auditEvent.create({
      data: {
        action: 'PASSWORD_RESET_REQUEST',
        entityType: 'auth',
        after: { matched: false },
        ipAddress: input.ipAddress || null
      }
    }).catch(() => undefined);
    return;
  }

  const raw = generateResetToken();
  const tokenHash = hashResetToken(raw);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  // Cap outstanding unused tokens.
  const open = await prisma.passwordResetToken.findMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' }
  });
  if (open.length >= MAX_ACTIVE_TOKENS_PER_USER) {
    const oldest = open.slice(0, open.length - MAX_ACTIVE_TOKENS_PER_USER + 1);
    await prisma.passwordResetToken.updateMany({
      where: { id: { in: oldest.map((t) => t.id) } },
      data: { usedAt: new Date() }
    });
  }

  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt }
  });

  await prisma.auditEvent.create({
    data: {
      actorId: user.id,
      action: 'PASSWORD_RESET_REQUEST',
      entityType: 'auth',
      entityId: user.id,
      after: { matched: true, emailConfigured: isEmailConfigured() },
      ipAddress: input.ipAddress || null
    }
  }).catch(() => undefined);

  if (!isEmailConfigured()) {
    // Do not invent a mock provider. Token is created; ops must configure email.
    return;
  }

  const link = `${appBaseUrl().replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(raw)}`;
  await sendEmail({
    to: user.email,
    subject: 'Password reset instructions',
    html: `
      <p>Hello ${escapeHtml(user.name)},</p>
      <p>We received a request to reset your eClinicAssist password.</p>
      <p><a href="${escapeHtml(link)}">Reset your password</a></p>
      <p>This link expires in one hour and can be used once. If you did not request this, you can ignore this email.</p>
    `
  });
}

export async function resetPasswordWithToken(input: {
  rawToken: string;
  newPassword: string;
  ipAddress?: string | null;
}) {
  const tokenHash = hashResetToken(input.rawToken);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    const err: any = new Error('This reset link is invalid or has expired');
    err.status = 400;
    err.code = 'RESET_TOKEN_INVALID';
    throw err;
  }
  const password = String(input.newPassword || '');
  if (password.length < 10) {
    const err: any = new Error('Password must be at least 10 characters');
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    // Invalidate sibling unused tokens for this user.
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null, id: { not: row.id } },
      data: { usedAt: new Date() }
    });
  });

  await revokeAllSessionsForUser(row.userId);

  await prisma.auditEvent.create({
    data: {
      actorId: row.userId,
      action: 'PASSWORD_RESET_COMPLETED',
      entityType: 'auth',
      entityId: row.userId,
      after: { sessionsRevoked: true },
      ipAddress: input.ipAddress || null
    }
  }).catch(() => undefined);
}
