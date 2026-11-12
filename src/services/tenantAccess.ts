import {
  Role,
  TenantMembershipStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isPlatformAdmin } from './tenants';

export const TENANT_HEADER = 'x-tenant-id';
export const PLATFORM_ACCESS_HEADER = 'x-platform-access';

export type TenantAuthContext = {
  userId: string;
  platformRole: Role;
  /** Active tenant for this request, if resolved. */
  tenantId: string | null;
  membershipId: string | null;
  tenantRole: TenantRole | null;
  membershipStatus: TenantMembershipStatus | null;
  /** Explicit platform elevated mode (ADMIN + X-Platform-Access). */
  platformAccess: boolean;
  /** True when user must pick a tenant (multiple memberships, none selected). */
  tenantSelectionRequired: boolean;
  activeMemberships: Array<{
    id: string;
    tenantId: string;
    role: TenantRole;
    status: TenantMembershipStatus;
    tenant: { id: string; name: string; slug: string; status: TenantStatus };
  }>;
};

export function denyAccess(message = 'Access denied', status = 403): never {
  const err: any = new Error(message);
  err.status = status;
  err.code = 'ACCESS_DENIED';
  throw err;
}

/** Cross-tenant / unauthorized record access — do not leak existence. */
export function denyNotFound(): never {
  const err: any = new Error('Record not found');
  err.status = 404;
  err.code = 'NOT_FOUND';
  throw err;
}

export function wantsPlatformAccess(headerValue: unknown): boolean {
  const v = String(headerValue || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export async function loadActiveMemberships(userId: string) {
  return prisma.tenantMembership.findMany({
    where: {
      userId,
      status: TenantMembershipStatus.ACTIVE,
      tenant: { status: TenantStatus.ACTIVE }
    },
    include: {
      tenant: { select: { id: true, name: true, slug: true, status: true } }
    },
    orderBy: { createdAt: 'asc' }
  });
}

/**
 * Resolve trusted tenant context from DB membership (never trust client alone).
 * Policy:
 * - X-Tenant-Id must match an ACTIVE membership (or platform elevated ADMIN).
 * - Single active membership may auto-select when header omitted.
 * - Multiple memberships require explicit selection for tenant-scoped work.
 * - Membership status is always loaded fresh from DB (revocation is immediate).
 */
export async function resolveTenantAuthContext(input: {
  userId: string;
  platformRole: Role;
  requestedTenantId?: string | null;
  platformAccessHeader?: unknown;
}): Promise<TenantAuthContext> {
  const activeMemberships = await loadActiveMemberships(input.userId);
  const platformAccess =
    isPlatformAdmin(input.platformRole) && wantsPlatformAccess(input.platformAccessHeader);
  const requested = String(input.requestedTenantId || '').trim() || null;

  let tenantId: string | null = null;
  let membershipId: string | null = null;
  let tenantRole: TenantRole | null = null;
  let membershipStatus: TenantMembershipStatus | null = null;
  let tenantSelectionRequired = false;

  if (requested) {
    const membership = activeMemberships.find((m) => m.tenantId === requested);
    if (membership) {
      tenantId = membership.tenantId;
      membershipId = membership.id;
      tenantRole = membership.role;
      membershipStatus = membership.status;
    } else if (platformAccess) {
      const tenant = await prisma.tenant.findFirst({
        where: { id: requested, status: TenantStatus.ACTIVE },
        select: { id: true }
      });
      if (!tenant) denyAccess('Access denied');
      tenantId = tenant.id;
      membershipId = null;
      tenantRole = null;
      membershipStatus = null;
    } else {
      // Do not reveal whether the tenant exists.
      denyAccess('Access denied');
    }
  } else if (activeMemberships.length === 1) {
    const only = activeMemberships[0];
    tenantId = only.tenantId;
    membershipId = only.id;
    tenantRole = only.role;
    membershipStatus = only.status;
  } else if (activeMemberships.length > 1) {
    tenantSelectionRequired = true;
  }

  return {
    userId: input.userId,
    platformRole: input.platformRole,
    tenantId,
    membershipId,
    tenantRole,
    membershipStatus,
    platformAccess,
    tenantSelectionRequired,
    activeMemberships
  };
}

export function requireTenantContext(ctx: TenantAuthContext | undefined | null): asserts ctx is TenantAuthContext & { tenantId: string } {
  if (!ctx) denyAccess('Authentication required', 401);
  if (ctx.tenantSelectionRequired && !ctx.tenantId) {
    const err: any = new Error('Tenant selection required');
    err.status = 400;
    err.code = 'TENANT_SELECTION_REQUIRED';
    throw err;
  }
  if (!ctx.tenantId) denyAccess('Tenant context required');
}

export function requirePlatformAccess(ctx: TenantAuthContext | undefined | null) {
  if (!ctx) denyAccess('Authentication required', 401);
  if (!isPlatformAdmin(ctx.platformRole) || !ctx.platformAccess) {
    denyAccess('Platform access required');
  }
}

export function requireTenantRole(ctx: TenantAuthContext, roles: TenantRole[]) {
  requireTenantContext(ctx);
  if (ctx.platformAccess && isPlatformAdmin(ctx.platformRole)) return;
  if (!ctx.tenantRole || !roles.includes(ctx.tenantRole)) denyAccess('Insufficient tenant permissions');
}

/** Organization IDs belonging to the active tenant. Empty array = none (deny-by-empty). */
export async function getTenantOrganizationIds(tenantId: string): Promise<string[]> {
  const rows = await prisma.organization.findMany({
    where: { tenantId },
    select: { id: true }
  });
  return rows.map((r) => r.id);
}

export function tenantOrgWhere(tenantId: string) {
  return { tenantId };
}

/** Provider visible in tenant via TenantProvider ownership. */
export function providerInTenantWhere(tenantId: string) {
  return { tenantLinks: { some: { tenantId } } };
}

export async function assertOrganizationInTenant(tenantId: string, organizationId: string | null | undefined) {
  if (!organizationId) denyNotFound();
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, tenantId },
    select: { id: true }
  });
  if (!org) denyNotFound();
}

export async function assertProviderInTenant(tenantId: string, providerId: string | null | undefined) {
  if (!providerId) denyNotFound();
  const link = await prisma.tenantProvider.findFirst({
    where: { tenantId, providerId },
    select: { id: true }
  });
  if (!link) denyNotFound();
}

export async function ensureTenantProvider(tenantId: string, providerId: string) {
  return prisma.tenantProvider.upsert({
    where: { tenantId_providerId: { tenantId, providerId } },
    update: {},
    create: { tenantId, providerId }
  });
}

/**
 * Resolve tenantId owning a business record. Returns null when unmapped/unknown.
 * Unknown ownership is denied for tenant-scoped access (caller must deny).
 */
export async function resolveRecordTenantId(resource: string, id: string): Promise<string | null> {
  switch (resource) {
    case 'organizations': {
      const row = await prisma.organization.findUnique({ where: { id }, select: { tenantId: true } });
      return row?.tenantId || null;
    }
    case 'practices': {
      const row = await prisma.practice.findUnique({
        where: { id },
        select: { organization: { select: { tenantId: true } } }
      });
      return row?.organization?.tenantId || null;
    }
    case 'facilities': {
      const row = await prisma.facility.findUnique({
        where: { id },
        select: {
          organization: { select: { tenantId: true } },
          practice: { select: { organization: { select: { tenantId: true } } } }
        }
      });
      return row?.organization?.tenantId || row?.practice?.organization?.tenantId || null;
    }
    case 'providers': {
      const row = await prisma.tenantProvider.findFirst({
        where: { providerId: id },
        select: { tenantId: true }
      });
      return row?.tenantId || null;
    }
    case 'providerOrganizations': {
      const row = await prisma.providerOrganization.findUnique({
        where: { id },
        select: { organization: { select: { tenantId: true } } }
      });
      return row?.organization?.tenantId || null;
    }
    case 'licenses': {
      const row = await prisma.license.findUnique({
        where: { id },
        select: {
          tenantId: true,
          provider: { select: { tenantLinks: { select: { tenantId: true } } } }
        }
      });
      if (!row) return null;
      if (row.tenantId) return row.tenantId;
      const links = row.provider?.tenantLinks?.map((l) => l.tenantId) || [];
      // Ambiguous multi-tenant provider without license.tenantId → deny (null).
      return links.length === 1 ? links[0] : null;
    }
    case 'documents': {
      const row = await prisma.document.findUnique({
        where: { id },
        select: {
          tenantId: true,
          organization: { select: { tenantId: true } },
          practice: { select: { organization: { select: { tenantId: true } } } },
          facility: {
            select: {
              organization: { select: { tenantId: true } },
              practice: { select: { organization: { select: { tenantId: true } } } }
            }
          },
          provider: { select: { tenantLinks: { select: { tenantId: true }, take: 1 } } },
          enrollment: { select: { tenantId: true } },
          intakeRequest: { select: { tenantId: true } }
        }
      });
      return (
        row?.tenantId
        || row?.organization?.tenantId
        || row?.practice?.organization?.tenantId
        || row?.facility?.organization?.tenantId
        || row?.facility?.practice?.organization?.tenantId
        || row?.provider?.tenantLinks?.[0]?.tenantId
        || row?.enrollment?.tenantId
        || row?.intakeRequest?.tenantId
        || null
      );
    }
    case 'cases': {
      const row = await prisma.credentialingCase.findUnique({
        where: { id },
        select: {
          tenantId: true,
          practice: { select: { organization: { select: { tenantId: true } } } },
          provider: { select: { tenantLinks: { select: { tenantId: true }, take: 1 } } }
        }
      });
      return (
        row?.tenantId
        || row?.practice?.organization?.tenantId
        || row?.provider?.tenantLinks?.[0]?.tenantId
        || null
      );
    }
    case 'enrollments': {
      const row = await prisma.enrollmentApplication.findUnique({
        where: { id },
        select: {
          tenantId: true,
          organization: { select: { tenantId: true } },
          practice: { select: { organization: { select: { tenantId: true } } } },
          facility: {
            select: {
              organization: { select: { tenantId: true } },
              practice: { select: { organization: { select: { tenantId: true } } } }
            }
          },
          provider: { select: { tenantLinks: { select: { tenantId: true }, take: 1 } } }
        }
      });
      return (
        row?.tenantId
        || row?.organization?.tenantId
        || row?.practice?.organization?.tenantId
        || row?.facility?.organization?.tenantId
        || row?.facility?.practice?.organization?.tenantId
        || row?.provider?.tenantLinks?.[0]?.tenantId
        || null
      );
    }
    case 'tasks': {
      const row = await prisma.task.findUnique({
        where: { id },
        select: {
          tenantId: true,
          organization: { select: { tenantId: true } },
          practice: { select: { organization: { select: { tenantId: true } } } },
          facility: {
            select: {
              organization: { select: { tenantId: true } },
              practice: { select: { organization: { select: { tenantId: true } } } }
            }
          },
          provider: { select: { tenantLinks: { select: { tenantId: true }, take: 1 } } },
          enrollment: { select: { tenantId: true } },
          credentialingCase: { select: { tenantId: true } }
        }
      });
      return (
        row?.tenantId
        || row?.organization?.tenantId
        || row?.practice?.organization?.tenantId
        || row?.facility?.organization?.tenantId
        || row?.facility?.practice?.organization?.tenantId
        || row?.provider?.tenantLinks?.[0]?.tenantId
        || row?.enrollment?.tenantId
        || row?.credentialingCase?.tenantId
        || null
      );
    }
    case 'intake': {
      const row = await prisma.intakeRequest.findUnique({
        where: { id },
        select: {
          tenantId: true,
          organization: { select: { tenantId: true } }
        }
      });
      return row?.tenantId || row?.organization?.tenantId || null;
    }
    default:
      return null;
  }
}

export async function assertRecordInTenant(ctx: TenantAuthContext, resource: string, id: string) {
  requireTenantContext(ctx);
  // Licenses: prefer License.tenantId; always require an active TenantProvider link for ctx.tenantId
  // (do not use "first tenant link" which enables cross-tenant IDOR for shared providers).
  if (resource === 'licenses') {
    const lic = await prisma.license.findUnique({
      where: { id },
      select: { tenantId: true, providerId: true }
    });
    if (!lic) denyNotFound();
    if (lic.tenantId && lic.tenantId !== ctx.tenantId) denyNotFound();
    const link = await prisma.tenantProvider.findUnique({
      where: { tenantId_providerId: { tenantId: ctx.tenantId!, providerId: lic.providerId } }
    });
    if (!link) denyNotFound();
    return;
  }
  const ownerTenantId = await resolveRecordTenantId(resource, id);
  if (!ownerTenantId || ownerTenantId !== ctx.tenantId) denyNotFound();
}

/** Build Prisma where clause for tenant-scoped list queries. */
export function listWhereForResource(resource: string, tenantId: string): Record<string, unknown> | null {
  switch (resource) {
    case 'organizations':
      return { tenantId };
    case 'practices':
      return { organization: { is: { tenantId } } };
    case 'facilities':
      return {
        OR: [
          { organization: { is: { tenantId } } },
          { practice: { is: { organization: { is: { tenantId } } } } }
        ]
      };
    case 'providers':
      return providerInTenantWhere(tenantId);
    case 'providerOrganizations':
      return { organization: { is: { tenantId } } };
    case 'licenses':
      return { provider: { is: providerInTenantWhere(tenantId) } };
    case 'documents':
      return {
        OR: [
          { tenantId },
          { organization: { is: { tenantId } } },
          { practice: { is: { organization: { is: { tenantId } } } } },
          { facility: { is: { OR: [{ organization: { is: { tenantId } } }, { practice: { is: { organization: { is: { tenantId } } } } }] } } },
          { provider: { is: providerInTenantWhere(tenantId) } },
          { enrollment: { is: { tenantId } } },
          { intakeRequest: { is: { tenantId } } }
        ]
      };
    case 'cases':
      return {
        OR: [
          { tenantId },
          { practice: { is: { organization: { is: { tenantId } } } } },
          { provider: { is: providerInTenantWhere(tenantId) } }
        ]
      };
    case 'enrollments':
      return {
        OR: [
          { tenantId },
          { organization: { is: { tenantId } } },
          { practice: { is: { organization: { is: { tenantId } } } } },
          { facility: { is: { OR: [{ organization: { is: { tenantId } } }, { practice: { is: { organization: { is: { tenantId } } } } }] } } },
          { provider: { is: providerInTenantWhere(tenantId) } }
        ]
      };
    case 'tasks':
      return {
        OR: [
          { tenantId },
          { organization: { is: { tenantId } } },
          { practice: { is: { organization: { is: { tenantId } } } } },
          { facility: { is: { OR: [{ organization: { is: { tenantId } } }, { practice: { is: { organization: { is: { tenantId } } } } }] } } },
          { provider: { is: providerInTenantWhere(tenantId) } },
          { enrollment: { is: { tenantId } } },
          { credentialingCase: { is: { tenantId } } }
        ]
      };
    case 'payers':
    case 'plans':
    case 'employees':
      return null; // platform-global
    default:
      return { id: '__no_such_resource__' };
  }
}

export function andWhere(base: Record<string, unknown>, extra: Record<string, unknown> | null | undefined) {
  if (!extra || !Object.keys(extra).length) return base;
  if (!base || !Object.keys(base).length) return extra;
  return { AND: [base, extra] };
}

export async function assertRelatedRecordsSameTenant(tenantId: string, refs: {
  organizationId?: string | null;
  practiceId?: string | null;
  facilityId?: string | null;
  providerId?: string | null;
  enrollmentId?: string | null;
  caseId?: string | null;
  billingEntityId?: string | null;
}) {
  if (refs.organizationId) await assertOrganizationInTenant(tenantId, refs.organizationId);
  if (refs.practiceId) {
    const practice = await prisma.practice.findFirst({
      where: { id: refs.practiceId, organization: { is: { tenantId } } },
      select: { id: true, organizationId: true }
    });
    if (!practice) denyNotFound();
  }
  if (refs.facilityId) {
    const facility = await prisma.facility.findFirst({
      where: {
        id: refs.facilityId,
        OR: [
          { organization: { is: { tenantId } } },
          { practice: { is: { organization: { is: { tenantId } } } } }
        ]
      },
      select: { id: true }
    });
    if (!facility) denyNotFound();
  }
  if (refs.providerId) await assertProviderInTenant(tenantId, refs.providerId);
  if (refs.enrollmentId) {
    const tid = await resolveRecordTenantId('enrollments', refs.enrollmentId);
    if (tid !== tenantId) denyNotFound();
  }
  if (refs.caseId) {
    const tid = await resolveRecordTenantId('cases', refs.caseId);
    if (tid !== tenantId) denyNotFound();
  }
  if (refs.billingEntityId) {
    const be = await prisma.billingEntity.findFirst({
      where: { id: refs.billingEntityId, tenantId },
      select: { id: true }
    });
    if (!be) denyNotFound();
  }
}
