/**
 * Server-side session issuance / revocation (H7).
 * JWT carries jti; AuthSession row enables logout and password-reset invalidation.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseJwtExpiryMs } from '../lib/sessionCookies';

export type SessionUser = { id: string; email: string; role: Role; jti?: string };

export async function createAuthSession(input: {
  userId: string;
  email: string;
  role: Role;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    const err: any = new Error('JWT_SECRET must be at least 32 characters');
    err.status = 500;
    throw err;
  }
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + parseJwtExpiryMs());
  await prisma.authSession.create({
    data: {
      userId: input.userId,
      jti,
      expiresAt,
      ipAddress: input.ipAddress || null,
      userAgent: input.userAgent ? String(input.userAgent).slice(0, 500) : null
    }
  });
  const token = jwt.sign(
    { id: input.userId, email: input.email, role: input.role, jti },
    secret,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as any }
  );
  return { token, jti, expiresAt };
}

export async function assertSessionActive(jti: string | undefined | null): Promise<void> {
  if (!jti) {
    // Legacy tokens without jti are rejected — force re-login after hardening deploy.
    const err: any = new Error('Invalid or expired session');
    err.status = 401;
    throw err;
  }
  const row = await prisma.authSession.findUnique({ where: { jti } });
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    const err: any = new Error('Invalid or expired session');
    err.status = 401;
    throw err;
  }
}

export async function revokeSessionByJti(jti: string | undefined | null) {
  if (!jti) return;
  await prisma.authSession.updateMany({
    where: { jti, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function revokeAllSessionsForUser(userId: string) {
  await prisma.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}
