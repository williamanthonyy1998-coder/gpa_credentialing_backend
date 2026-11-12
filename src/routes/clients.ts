import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  Role,
  TenantOnboardingStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { AuthRequest, allowRoles } from '../middleware/auth';
import { audit } from '../lib/audit';
import {
  assertGpaClientAdmin,
  createClientAccount,
  getClientDetail,
  listClientAccounts,
  updateClientAccount
} from '../services/clients';
import {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation
} from '../services/invitations';

const router = Router();

const gpaRoles = [Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[];

const inviteResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invitation requests. Try again later.' }
});

router.post('/invitations/:invitationId/resend', allowRoles(...gpaRoles), inviteResendLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const result = await resendInvitation(req.params.invitationId, req.user!.id);
    await audit(req, 'INVITATION_RESEND', 'tenantInvitations', result.invitation.id, undefined, {
      tenantId: result.invitation.tenantId,
      email: result.invitation.email,
      deliveryStatus: result.invitation.deliveryStatus
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/invitations/:invitationId/revoke', allowRoles(...gpaRoles), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const row = await revokeInvitation(req.params.invitationId);
    await audit(req, 'INVITATION_REVOKE', 'tenantInvitations', row.id, undefined, {
      tenantId: row.tenantId,
      email: row.email,
      status: row.status
    });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/', allowRoles(...gpaRoles), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const result = await listClientAccounts({
      q: String(req.query.q || ''),
      status: (String(req.query.status || '').toUpperCase() || undefined) as TenantStatus | undefined,
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 25
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/', allowRoles(...gpaRoles), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const body = z.object({
      name: z.string().min(2),
      slug: z.string().optional(),
      primaryContactName: z.string().optional().nullable(),
      primaryContactEmail: z.string().email().optional().or(z.literal('')).nullable(),
      primaryContactPhone: z.string().optional().nullable(),
      internalNotes: z.string().optional().nullable(),
      status: z.nativeEnum(TenantStatus).optional()
    }).parse(req.body);
    const row = await createClientAccount({
      ...body,
      primaryContactEmail: body.primaryContactEmail || null
    });
    await audit(req, 'CLIENT_CREATE', 'tenants', row.id, undefined, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      onboardingStatus: row.onboardingStatus
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', allowRoles(...gpaRoles), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const row = await getClientDetail(req.params.id, { includeInternalNotes: true });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', allowRoles(...gpaRoles), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const body = z.object({
      name: z.string().min(2).optional(),
      slug: z.string().optional(),
      primaryContactName: z.string().optional().nullable(),
      primaryContactEmail: z.string().email().optional().or(z.literal('')).nullable(),
      primaryContactPhone: z.string().optional().nullable(),
      internalNotes: z.string().optional().nullable(),
      status: z.nativeEnum(TenantStatus).optional(),
      onboardingStatus: z.nativeEnum(TenantOnboardingStatus).optional()
    }).parse(req.body);
    const before = await getClientDetail(req.params.id, { includeInternalNotes: true });
    const row = await updateClientAccount(req.params.id, body, { includeInternalNotes: true });
    await audit(req, 'CLIENT_UPDATE', 'tenants', row.id, {
      name: before.name,
      status: before.status,
      onboardingStatus: before.onboardingStatus
    }, {
      name: row.name,
      status: row.status,
      onboardingStatus: row.onboardingStatus
    });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/:id/invitations', allowRoles(...gpaRoles), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    res.json(await listInvitations(req.params.id));
  } catch (e) {
    next(e);
  }
});

router.post('/:id/invitations', allowRoles(...gpaRoles), inviteResendLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    assertGpaClientAdmin(req.user!.role);
    const body = z.object({
      email: z.string().email(),
      role: z.nativeEnum(TenantRole).default(TenantRole.TENANT_ADMIN),
      send: z.boolean().optional()
    }).parse(req.body);
    const result = await createInvitation({
      tenantId: req.params.id,
      email: body.email,
      role: body.role,
      invitedById: req.user!.id,
      send: body.send
    });
    await audit(req, 'INVITATION_CREATE', 'tenantInvitations', result.invitation.id, undefined, {
      tenantId: req.params.id,
      email: result.invitation.email,
      role: result.invitation.role,
      deliveryStatus: result.invitation.deliveryStatus
    });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
