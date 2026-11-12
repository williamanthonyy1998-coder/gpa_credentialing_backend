import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, authenticate, attachTenantContext } from '../middleware/auth';
import {
  acceptProviderIntakeInvitation,
  validateProviderInviteToken
} from '../services/providerInvitations';

const router = Router();

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

    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(500).json({ error: 'Server authentication configuration is invalid' });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { id: true, email: true, name: true, role: true }
    });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as any }
    );

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
      token,
      user,
      tenants: [],
      defaultTenantId: null,
      intakeRequestId: result.intakeRequestId,
      redirectTo: `/provider-portal/intakes/${result.intakeRequestId}`
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

router.post('/:token/accept-authenticated', acceptLimiter, authenticate, attachTenantContext, async (req: AuthRequest, res: Response, next: NextFunction) => {
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
