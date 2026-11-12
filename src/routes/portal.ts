import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Role, TenantMembershipStatus, TenantOnboardingStatus, TenantRole } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { audit } from '../lib/audit';
import { prisma } from '../lib/prisma';
import { requireTenantContext } from '../services/tenantAccess';
import {
  canManageTenantUsers,
  canWriteTenantRecords,
  getPortalDashboard,
  sanitizeClientForPortal,
  updateClientAccount
} from '../services/clients';
import { createInvitation, listInvitations } from '../services/invitations';

const router = Router();

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invitation requests. Try again later.' }
});

router.get('/dashboard', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const data = await getPortalDashboard(req.tenantContext!.tenantId!);
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.get('/profile', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenantContext!.tenantId! } });
    if (!tenant) return res.status(404).json({ error: 'Client account not found' });
    res.json(sanitizeClientForPortal(tenant));
  } catch (e) {
    next(e);
  }
});

router.patch('/profile', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageTenantUsers(req.tenantContext!.tenantRole) && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const body = z.object({
      primaryContactName: z.string().optional().nullable(),
      primaryContactEmail: z.string().email().optional().or(z.literal('')).nullable(),
      primaryContactPhone: z.string().optional().nullable()
    }).parse(req.body);
    // Client-driven profile updates move onboarding toward PROFILE_PENDING / UNDER_REVIEW when appropriate
    const current = await prisma.tenant.findUnique({ where: { id: req.tenantContext!.tenantId! } });
    let onboardingStatus = current?.onboardingStatus;
    if (
      onboardingStatus === TenantOnboardingStatus.ACCOUNT_ACTIVATED ||
      onboardingStatus === TenantOnboardingStatus.NOT_STARTED ||
      onboardingStatus === TenantOnboardingStatus.INVITED
    ) {
      onboardingStatus = TenantOnboardingStatus.PROFILE_PENDING;
    }
    const row = await updateClientAccount(
      req.tenantContext!.tenantId!,
      { ...body, onboardingStatus },
      { includeInternalNotes: false }
    );
    await audit(req, 'CLIENT_PROFILE_UPDATE', 'tenants', row.id, undefined, {
      primaryContactName: row.primaryContactName,
      onboardingStatus: row.onboardingStatus
    });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/invitations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageTenantUsers(req.tenantContext!.tenantRole) && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    res.json(await listInvitations(req.tenantContext!.tenantId!));
  } catch (e) {
    next(e);
  }
});

router.post('/invitations', inviteLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageTenantUsers(req.tenantContext!.tenantRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const body = z.object({
      email: z.string().email(),
      role: z.nativeEnum(TenantRole).default(TenantRole.CREDENTIALING_SPECIALIST),
      send: z.boolean().optional()
    }).parse(req.body);
    const result = await createInvitation({
      tenantId: req.tenantContext!.tenantId!,
      email: body.email,
      role: body.role,
      invitedById: req.user!.id,
      send: body.send
    });
    await audit(req, 'INVITATION_CREATE', 'tenantInvitations', result.invitation.id, undefined, {
      tenantId: req.tenantContext!.tenantId,
      email: result.invitation.email,
      role: result.invitation.role
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.get('/members', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageTenantUsers(req.tenantContext!.tenantRole) && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const rows = await prisma.tenantMembership.findMany({
      where: { tenantId: req.tenantContext!.tenantId! },
      include: { user: { select: { id: true, name: true, email: true, role: true, active: true } } },
      orderBy: { createdAt: 'asc' }
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.patch('/members/:membershipId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageTenantUsers(req.tenantContext!.tenantRole) && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const body = z.object({
      status: z.nativeEnum(TenantMembershipStatus).optional(),
      role: z.nativeEnum(TenantRole).optional()
    }).parse(req.body);
    const membership = await prisma.tenantMembership.findUnique({ where: { id: req.params.membershipId } });
    if (!membership || membership.tenantId !== req.tenantContext!.tenantId) {
      return res.status(404).json({ error: 'Membership not found' });
    }
    if (membership.userId === req.user!.id && body.role && body.role !== membership.role) {
      return res.status(403).json({ error: 'You cannot change your own role' });
    }
    const updated = await prisma.tenantMembership.update({
      where: { id: membership.id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.role ? { role: body.role } : {})
      },
      include: { user: { select: { id: true, name: true, email: true, role: true, active: true } } }
    });
    await audit(req, 'MEMBERSHIP_UPDATE', 'tenantMemberships', updated.id, membership, {
      status: updated.status,
      role: updated.role
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

router.get('/organizations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const rows = await prisma.organization.findMany({
      where: { tenantId: req.tenantContext!.tenantId! },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        legalName: true,
        dba: true,
        status: true,
        contactName: true,
        email: true,
        phone: true,
        createdAt: true
      }
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/organizations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canWriteTenantRecords(req.tenantContext!.tenantRole) && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const body = z.object({
      legalName: z.string().min(2),
      dba: z.string().optional().nullable(),
      taxId: z.string().optional().nullable(),
      contactName: z.string().optional().nullable(),
      contactTitle: z.string().optional().nullable(),
      phone: z.string().optional().nullable(),
      email: z.string().email().optional().or(z.literal('')).nullable(),
      mailingAddress: z.any().optional()
    }).parse(req.body);

    const tenantId = req.tenantContext!.tenantId!;
    const duplicate = await prisma.organization.findFirst({
      where: {
        tenantId,
        legalName: { equals: body.legalName.trim(), mode: 'insensitive' }
      },
      select: { id: true }
    });
    if (duplicate) return res.status(409).json({ error: 'An organization with this legal name already exists for this client' });

    const sensitive = Boolean(body.taxId);
    if (sensitive && !([Role.ADMIN, Role.CREDENTIALING_MANAGER, Role.CLIENT_USER] as Role[]).includes(req.user!.role)) {
      // allow tenant writers who can manage
    }

    const row = await prisma.organization.create({
      data: {
        tenantId,
        legalName: body.legalName.trim(),
        dba: body.dba || null,
        taxId: body.taxId || null,
        contactName: body.contactName || null,
        contactTitle: body.contactTitle || null,
        phone: body.phone || null,
        email: body.email || null,
        mailingAddress: body.mailingAddress || undefined,
        status: 'PENDING'
      }
    });

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant && (tenant.onboardingStatus === TenantOnboardingStatus.ACCOUNT_ACTIVATED || tenant.onboardingStatus === TenantOnboardingStatus.PROFILE_PENDING)) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { onboardingStatus: TenantOnboardingStatus.UNDER_REVIEW }
      });
    }

    await audit(req, 'CREATE', 'organizations', row.id, undefined, {
      id: row.id,
      legalName: row.legalName,
      tenantId,
      taxId: body.taxId ? '[REDACTED]' : null
    });
    const { taxId, bankAccountNumber, bankRoutingNumber, ...safe } = row as any;
    res.status(201).json(safe);
  } catch (e) {
    next(e);
  }
});

/** Client-facing provider intake management (no GPA internal notes). */
router.get('/provider-intakes', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const tenantId = req.tenantContext!.tenantId!;
    const rows = await prisma.intakeRequest.findMany({
      where: { tenantId, kind: { in: ['PROVIDER', 'COMBINED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        referenceNo: true,
        kind: true,
        status: true,
        invitedEmail: true,
        contactName: true,
        contactEmail: true,
        submittedAt: true,
        approvedAt: true,
        convertedAt: true,
        createdAt: true,
        updatedAt: true,
        reviewerComments: true,
        rejectionReason: true,
        identityMatch: true,
        missingFields: true
      }
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/provider-intakes', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    if (!canManageTenantUsers(req.tenantContext!.tenantRole) && req.user!.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const body = z.object({
      contactName: z.string().optional().nullable(),
      contactEmail: z.string().email(),
      contactPhone: z.string().optional().nullable(),
      organizationId: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      invite: z.boolean().optional()
    }).parse(req.body);
    const tenantId = req.tenantContext!.tenantId!;
    const referenceNo = `INT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const row = await prisma.intakeRequest.create({
      data: {
        tenantId,
        referenceNo,
        kind: 'PROVIDER',
        status: 'DRAFT',
        organizationId: body.organizationId || null,
        createdById: req.user!.id,
        contactName: body.contactName || null,
        contactEmail: body.contactEmail.toLowerCase(),
        contactPhone: body.contactPhone || null,
        invitedEmail: body.contactEmail.toLowerCase(),
        notes: body.notes || null,
        payload: { provider: { email: body.contactEmail.toLowerCase() } }
      }
    });
    await prisma.intakeEvent.create({
      data: { intakeId: row.id, action: 'CREATED', actorId: req.user!.id, detail: { source: 'client_portal' } }
    });
    await audit(req, 'CREATE', 'intake', row.id, undefined, { referenceNo: row.referenceNo, source: 'client_portal' });

    let invitation: any = null;
    if (body.invite !== false) {
      const { createProviderIntakeInvitation } = await import('../services/providerInvitations');
      invitation = await createProviderIntakeInvitation({
        tenantId,
        intakeRequestId: row.id,
        email: body.contactEmail,
        invitedById: req.user!.id,
        send: true
      });
      await audit(req, 'PROVIDER_INVITATION_CREATE', 'providerIntakeInvitations', invitation.invitation.id, undefined, {
        email: body.contactEmail.toLowerCase()
      });
    }
    res.status(201).json({ intake: row, invitation });
  } catch (e: any) {
    if (e?.status) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/provider-intakes/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    requireTenantContext(req.tenantContext);
    const { assertRecordInTenant } = await import('../services/tenantAccess');
    const { sanitizeIntakeForClient } = await import('../services/providerIntake');
    await assertRecordInTenant(req.tenantContext!, 'intake', req.params.id);
    const row = await prisma.intakeRequest.findUnique({
      where: { id: req.params.id },
      include: {
        events: { orderBy: { createdAt: 'desc' }, take: 50 },
        documents: {
          where: { securityStatus: { not: 'DELETED' } },
          select: {
            id: true, title: true, type: true, category: true, status: true,
            securityStatus: true, originalName: true, sizeBytes: true, uploadedAt: true
          }
        },
        invitations: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true, email: true, status: true, deliveryStatus: true,
            expiresAt: true, acceptedAt: true, createdAt: true
          }
        }
      }
    });
    if (!row || row.tenantId !== req.tenantContext!.tenantId) {
      return res.status(404).json({ error: 'Intake request not found' });
    }
    res.json(sanitizeIntakeForClient(row));
  } catch (e) { next(e); }
});

export default router;
