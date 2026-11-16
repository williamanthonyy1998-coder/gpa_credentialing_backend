import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { TenantMembershipStatus, TenantStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest, attachTenantContext, requireCsrfForCookieAuth } from '../middleware/auth';
import { loadActiveMemberships } from '../services/tenantAccess';
import { createAuthSession, revokeAllSessionsForUser, revokeSessionByJti } from '../services/authSession';
import {
  clearCsrfCookie,
  clearSessionCookie,
  issueCsrfToken,
  setCsrfCookie,
  setSessionCookie
} from '../lib/sessionCookies';
import { requestPasswordReset, resetPasswordWithToken } from '../services/passwordReset';
import { isE2eLoginBypassAllowed } from '../lib/runtimeSecurity';
import { audit } from '../lib/audit';

const router = Router();

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isE2eLoginBypassAllowed() ? 10_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isE2eLoginBypassAllowed()
});

async function serializeTenants(userId: string) {
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId },
    include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: { createdAt: 'asc' }
  });
  return memberships.map((m) => ({
    membershipId: m.id,
    tenantId: m.tenantId,
    role: m.role,
    status: m.status,
    tenant: m.tenant,
    usable: m.status === TenantMembershipStatus.ACTIVE && m.tenant.status === TenantStatus.ACTIVE
  }));
}

function clientMeta(req: AuthRequest) {
  return {
    ipAddress: req.ip || (req.headers['x-forwarded-for'] as string) || null,
    userAgent: req.headers['user-agent'] || null
  };
}

router.post('/login', async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !user.active || !(await bcrypt.compare(input.password, user.passwordHash))) {
      await prisma.auditEvent.create({
        data: {
          action: 'LOGIN_FAILURE',
          entityType: 'auth',
          entityId: null,
          after: { emailPresented: true },
          ipAddress: clientMeta(req).ipAddress
        }
      }).catch(() => undefined);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const session = await createAuthSession({
      userId: user.id,
      email: user.email,
      role: user.role,
      ...clientMeta(req)
    });
    setSessionCookie(res, session.token);
    const csrf = issueCsrfToken();
    setCsrfCookie(res, csrf);
    const tenants = await serializeTenants(user.id);
    const active = await loadActiveMemberships(user.id);
    const defaultTenantId = active.length === 1 ? active[0].tenantId : null;
    await prisma.auditEvent.create({
      data: {
        actorId: user.id,
        action: 'LOGIN_SUCCESS',
        entityType: 'auth',
        entityId: user.id,
        after: { sessionIssued: true },
        ipAddress: clientMeta(req).ipAddress
      }
    }).catch(() => undefined);
    // Token is set in HttpOnly cookie — browser clients must not store JWT in web storage.
    // Isolated e2e only: include token for Playwright API helpers (never in production).
    const e2eToken = isE2eLoginBypassAllowed() ? session.token : undefined;
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenants,
      defaultTenantId,
      tenantSelectionRequired: active.length > 1,
      csrfToken: csrf,
      authMode: 'cookie',
      ...(e2eToken ? { token: e2eToken } : {})
    });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', authenticate, requireCsrfForCookieAuth, async (req: AuthRequest, res, next) => {
  try {
    await revokeSessionByJti(req.user?.jti);
    clearSessionCookie(res);
    clearCsrfCookie(res);
    await audit(req, 'LOGOUT', 'auth', req.user?.id, undefined, { revoked: true });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/csrf', authenticate, async (req: AuthRequest, res) => {
  const csrf = issueCsrfToken();
  setCsrfCookie(res, csrf);
  res.json({ csrfToken: csrf });
});

router.get('/me', authenticate, attachTenantContext, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, name: true, role: true, active: true }
    });
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid or expired session' });
    const tenants = await serializeTenants(user.id);
    res.json({
      ...user,
      tenants,
      tenantContext: {
        tenantId: req.tenantContext?.tenantId || null,
        membershipId: req.tenantContext?.membershipId || null,
        tenantRole: req.tenantContext?.tenantRole || null,
        membershipStatus: req.tenantContext?.membershipStatus || null,
        platformAccess: req.tenantContext?.platformAccess || false,
        tenantSelectionRequired: req.tenantContext?.tenantSelectionRequired || false
      },
      authMode: req.authViaCookie ? 'cookie' : 'bearer'
    });
  } catch (e) {
    next(e);
  }
});

/** SEC-18: always return generic success — do not reveal account existence. */
router.post('/password-reset/request', passwordResetLimiter, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({ email: z.string().email() }).parse(req.body);
    await requestPasswordReset({
      email: input.email,
      ipAddress: clientMeta(req).ipAddress
    });
    res.json({
      ok: true,
      message: 'If an account exists for that email, password reset instructions have been sent.'
    });
  } catch (e) {
    next(e);
  }
});

router.post('/password-reset/confirm', passwordResetLimiter, async (req: AuthRequest, res, next) => {
  try {
    const input = z.object({
      token: z.string().min(20),
      password: z.string().min(10).max(200)
    }).parse(req.body);
    await resetPasswordWithToken({
      rawToken: input.token,
      newPassword: input.password,
      ipAddress: clientMeta(req).ipAddress
    });
    clearSessionCookie(res);
    clearCsrfCookie(res);
    res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export { revokeAllSessionsForUser };
export default router;
