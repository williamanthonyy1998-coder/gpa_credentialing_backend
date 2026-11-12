import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { audit } from '../lib/audit';
import { AuthRequest, authenticate, attachTenantContext } from '../middleware/auth';
import {
  acceptInvitation,
  validateInvitationToken
} from '../services/invitations';
import { loadActiveMemberships } from '../services/tenantAccess';

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
    const info = await validateInvitationToken(req.params.token);
    res.json(info);
  } catch (e: any) {
    // Generic client message
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

    const result = await acceptInvitation({
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
    const tenants = await loadActiveMemberships(user.id);

    // Audit without request user — actor is the accepting user
    await prisma.auditEvent.create({
      data: {
        actorId: user.id,
        tenantId: result.tenantId,
        action: 'INVITATION_ACCEPT',
        entityType: 'tenantInvitations',
        entityId: undefined,
        after: { tenantId: result.tenantId, role: result.role, userId: user.id } as any
      }
    });

    res.json({
      token,
      user,
      tenants: tenants.map((m) => ({
        membershipId: m.id,
        tenantId: m.tenantId,
        role: m.role,
        status: m.status,
        tenant: m.tenant,
        usable: true
      })),
      defaultTenantId: result.tenantId,
      redirectTo: '/portal'
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

/** Authenticated acceptance for existing users (must match invitation email). */
router.post('/:token/accept-authenticated', acceptLimiter, authenticate, attachTenantContext, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await acceptInvitation({
      rawToken: req.params.token,
      email: req.user!.email,
      authenticatedUserId: req.user!.id
    });
    await audit(req, 'INVITATION_ACCEPT', 'tenantInvitations', undefined, undefined, {
      tenantId: result.tenantId,
      role: result.role,
      userId: result.userId
    });
    const tenants = await loadActiveMemberships(req.user!.id);
    res.json({
      tenantId: result.tenantId,
      role: result.role,
      tenants: tenants.map((m) => ({
        membershipId: m.id,
        tenantId: m.tenantId,
        role: m.role,
        status: m.status,
        tenant: m.tenant,
        usable: true
      })),
      redirectTo: '/portal'
    });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

export default router;
