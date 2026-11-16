/**
 * Central enrollment + intake organization ACL helpers (RT-06 closure).
 * Nested child routes must call these — never tenant-only assertRecordInTenant alone.
 */
import { Role } from '@prisma/client';
import { AuthRequest } from '../middleware/auth';
import { requireTenantContext, TenantAuthContext } from './tenantAccess';
import { assertResourceRecordAccess } from './orgAccess';
import { prisma } from '../lib/prisma';
import { denyNotFound } from './tenantAccess';

export async function assertEnrollmentAccess(
  userId: string,
  role: Role,
  enrollmentId: string,
  tenantCtx?: TenantAuthContext | null
) {
  await assertResourceRecordAccess(userId, role, 'enrollments', enrollmentId, tenantCtx);
}

/** Convenience for Express handlers under /api/enrollments/:id/... */
export async function assertEnrollmentAccessFromReq(req: AuthRequest, enrollmentId?: string) {
  requireTenantContext(req.tenantContext);
  const id = enrollmentId || String(req.params.id || '');
  if (!id) denyNotFound();
  await assertEnrollmentAccess(req.user!.id, req.user!.role, id, req.tenantContext);
}

/** Resolve enrollment from a revalidation id, then enforce org ACL. */
export async function assertRevalidationEnrollmentAccess(
  userId: string,
  role: Role,
  revalidationId: string,
  tenantCtx?: TenantAuthContext | null
) {
  requireTenantContext(tenantCtx || null);
  const row = await prisma.enrollmentRevalidation.findUnique({
    where: { id: revalidationId },
    select: { enrollmentId: true, tenantId: true }
  });
  if (!row?.enrollmentId) denyNotFound();
  if (tenantCtx?.tenantId && row.tenantId && row.tenantId !== tenantCtx.tenantId) denyNotFound();
  await assertEnrollmentAccess(userId, role, row.enrollmentId, tenantCtx);
}

export async function assertIntakeAccess(
  userId: string,
  role: Role,
  intakeId: string,
  tenantCtx?: TenantAuthContext | null
) {
  await assertResourceRecordAccess(userId, role, 'intake', intakeId, tenantCtx);
}

export async function assertIntakeAccessFromReq(req: AuthRequest, intakeId?: string) {
  requireTenantContext(req.tenantContext);
  const id = intakeId || String(req.params.id || '');
  if (!id) denyNotFound();
  await assertIntakeAccess(req.user!.id, req.user!.role, id, req.tenantContext);
}
