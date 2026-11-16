import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createAuthSession } from '../services/authSession';
import { issueCsrfToken, setCsrfCookie, setSessionCookie } from '../lib/sessionCookies';
import { audit } from '../lib/audit';
import { AuthRequest, authenticate, attachTenantContext, requireCsrfForCookieAuth } from '../middleware/auth';
import {
  acceptProviderIntakeInvitation,
  validateProviderInviteToken
} from '../services/providerInvitations';

const router = Router();

function clientMeta(req: { ip?: string; headers: Record<string, string | string[] | undefined> }) {
  const ua = req.headers['user-agent'];
  return {
    ipAddress: req.ip || (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : null),
    userAgent: Array.isArray(ua) ? ua[0] || null : (ua || null)
  };
}

const acceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' }
});

router.get('/:token', acceptLimiter, async (req, res: Response, next: NextFunction) => {
  try {
    const info = await validateProviderInviteToken(req.params.token);
    res.json(info);
  } catch (e: any) {
    if (e?.status === 400) return res.status(400).json({ error: 'Invitation is invalid or no longer available' });
    next(e);
  }
});

router.post('/:token/accept', acceptLimiter, async (req, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      email: z.string().email(),
      name: z.string().min(2).optional(),
      password: z.string().min(12).optional()
    }).parse(req.body);

    const result = await acceptProviderIntakeInvitation({
      rawToken: req.params.token,
      email: body.email,
      name: body.name,
      password: body.password
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { id: true, email: true, name: true, role: true }
    });
    const session = await createAuthSession({
      userId: user.id,
      email: user.email,
      role: user.role,
      ...clientMeta(req)
    });
    setSessionCookie(res, session.token);
    const csrf = issueCsrfToken();
    setCsrfCookie(res, csrf);

    await prisma.auditEvent.create({
      data: {
        actorId: user.id,
        tenantId: result.tenantId,
        action: 'PROVIDER_INVITATION_ACCEPT',
        entityType: 'providerIntakeInvitations',
        after: { intakeRequestId: result.intakeRequestId, userId: user.id } as any
      }
    });

    res.json({
      user,
      tenants: [],
      defaultTenantId: null,
      intakeRequestId: result.intakeRequestId,
      redirectTo: `/provider-portal/intakes/${result.intakeRequestId}`,
      csrfToken: csrf,
      authMode: 'cookie'
    });
  } catch (e: any) {
    if (e?.code === 'USER_EXISTS') {
      return res.status(409).json({
        error: 'An account with this email already exists. Sign in to accept the invitation.',
        code: 'USER_EXISTS'
      });
    }
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/:token/accept-authenticated', acceptLimiter, authenticate, requireCsrfForCookieAuth, attachTenantContext, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await acceptProviderIntakeInvitation({
      rawToken: req.params.token,
      email: req.user!.email,
      authenticatedUserId: req.user!.id
    });
    await audit(req, 'PROVIDER_INVITATION_ACCEPT', 'providerIntakeInvitations', undefined, undefined, {
      intakeRequestId: result.intakeRequestId,
      userId: result.userId
    });
    res.json({
      intakeRequestId: result.intakeRequestId,
      tenantId: result.tenantId,
      redirectTo: `/provider-portal/intakes/${result.intakeRequestId}`
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
