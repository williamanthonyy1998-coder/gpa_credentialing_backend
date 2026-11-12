import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { TenantMembershipStatus, TenantStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest, attachTenantContext } from '../middleware/auth';
import { loadActiveMemberships } from '../services/tenantAccess';

const router = Router();

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

router.post('/login', async (req, res, next) => {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user || !user.active || !(await bcrypt.compare(input.password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) return res.status(500).json({ error: 'JWT_SECRET must be at least 32 characters' });
    // JWT carries identity only — tenant authorization is always revalidated from DB.
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as any }
    );
    const tenants = await serializeTenants(user.id);
    const active = await loadActiveMemberships(user.id);
    const defaultTenantId = active.length === 1 ? active[0].tenantId : null;
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenants,
      defaultTenantId,
      tenantSelectionRequired: active.length > 1
    });
  } catch (e) {
    next(e);
  }
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
      }
    });
  } catch (e) {
    next(e);
  }
});

export default router;
