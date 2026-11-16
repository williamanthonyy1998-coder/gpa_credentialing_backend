/**
 * RT-06 — UserOrganization membership provisioning.
 * Assignments never cross tenants. CLIENT_USER defaults to deny until assigned.
 */
import { Role, TenantMembershipStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { assertOrganizationInTenant } from './tenantAccess';
import { canManageTenantUsers } from './clients';
import type { TenantAuthContext } from './tenantAccess';
import { TenantRole } from '@prisma/client';

function deny(message: string, status = 400, code?: string): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

export function canManageOrgMemberships(
  platformRole: Role,
  tenantRole: TenantRole | null | undefined
): boolean {
  if (platformRole === Role.ADMIN || platformRole === Role.CREDENTIALING_MANAGER) return true;
  return canManageTenantUsers(tenantRole);
}

export async function listUserOrganizations(input: {
  tenantId: string;
  userId: string;
}) {
  const membership = await prisma.tenantMembership.findFirst({
    where: {
      tenantId: input.tenantId,
      userId: input.userId,
      status: TenantMembershipStatus.ACTIVE
    },
    select: { id: true }
  });
  if (!membership) deny('User is not an active member of this tenant', 404, 'MEMBERSHIP_NOT_FOUND');

  const tenantOrgs = await prisma.organization.findMany({
    where: { tenantId: input.tenantId },
    select: { id: true }
  });
  const tenantOrgIds = tenantOrgs.map((o) => o.id);
  const rows = await prisma.userOrganization.findMany({
    where: { userId: input.userId, organizationId: { in: tenantOrgIds } },
    include: {
      organization: { select: { id: true, legalName: true, dba: true, status: true, tenantId: true } }
    },
    orderBy: { createdAt: 'asc' }
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    organizationId: r.organizationId,
    organization: r.organization,
    createdAt: r.createdAt
  }));
}

export async function assignUserOrganization(input: {
  tenantId: string;
  userId: string;
  organizationId: string;
  actorId: string;
  actorPlatformRole: Role;
  actorTenantRole?: TenantRole | null;
  actorTenantContext?: TenantAuthContext | null;
}) {
  if (!canManageOrgMemberships(input.actorPlatformRole, input.actorTenantRole)) {
    deny('Insufficient permissions to assign organization access', 403);
  }
  await assertOrganizationInTenant(input.tenantId, input.organizationId);

  const targetMembership = await prisma.tenantMembership.findFirst({
    where: {
      tenantId: input.tenantId,
      userId: input.userId,
      status: TenantMembershipStatus.ACTIVE
    },
    include: { user: { select: { id: true, role: true, email: true, name: true } } }
  });
  if (!targetMembership) deny('User is not an active member of this tenant', 404, 'MEMBERSHIP_NOT_FOUND');

  // Never assign organizations for platform GPA staff via this client path in a way that
  // silently expands cross-tenant access — membership already proves same-tenant.
  const existing = await prisma.userOrganization.findUnique({
    where: {
      userId_organizationId: {
        userId: input.userId,
        organizationId: input.organizationId
      }
    }
  });
  if (existing) return existing;

  return prisma.userOrganization.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId
    },
    include: {
      organization: { select: { id: true, legalName: true, dba: true, status: true, tenantId: true } }
    }
  });
}

export async function revokeUserOrganization(input: {
  tenantId: string;
  userId: string;
  organizationId: string;
  actorPlatformRole: Role;
  actorTenantRole?: TenantRole | null;
}) {
  if (!canManageOrgMemberships(input.actorPlatformRole, input.actorTenantRole)) {
    deny('Insufficient permissions to revoke organization access', 403);
  }
  await assertOrganizationInTenant(input.tenantId, input.organizationId);

  const existing = await prisma.userOrganization.findUnique({
    where: {
      userId_organizationId: {
        userId: input.userId,
        organizationId: input.organizationId
      }
    }
  });
  if (!existing) deny('Organization assignment not found', 404);

  await prisma.userOrganization.delete({ where: { id: existing.id } });
  return { revoked: true, userId: input.userId, organizationId: input.organizationId };
}
