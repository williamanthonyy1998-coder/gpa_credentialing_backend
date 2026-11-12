import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  TenantAuthContext,
  assertRecordInTenant,
  denyNotFound,
  getTenantOrganizationIds,
  requireTenantContext
} from './tenantAccess';

/**
 * Phase 0B: organization access is scoped to the active tenant.
 * Empty UserOrganization membership no longer grants global access.
 * Optional UserOrganization rows further narrow orgs within the tenant when present.
 */
export async function getAuthorizedOrganizationIds(
  userId: string,
  role: Role,
  tenantCtx?: TenantAuthContext | null
): Promise<string[]> {
  if (tenantCtx) {
    requireTenantContext(tenantCtx);
    const tenantOrgIds = await getTenantOrganizationIds(tenantCtx.tenantId);
    const memberships = await prisma.userOrganization.findMany({
      where: { userId, organizationId: { in: tenantOrgIds } },
      select: { organizationId: true }
    });
    // Within-tenant org ACL: if user has UserOrganization rows, intersect.
    // If none, all orgs in the active tenant are allowed (tenant membership is the boundary).
    if (memberships.length) {
      return memberships.map((m) => m.organizationId);
    }
    return tenantOrgIds;
  }

  // Legacy callers without tenant context: deny-by-default (empty).
  void userId;
  void role;
  return [];
}

export function orgScopeWhere(organizationIds: string[] | null | undefined): { in: string[] } | undefined {
  if (!organizationIds) return undefined;
  return { in: organizationIds };
}

export async function assertOrganizationAccess(
  userId: string,
  role: Role,
  organizationId: string | null | undefined,
  tenantCtx?: TenantAuthContext | null
) {
  if (!organizationId) {
    // Missing ownership is deny for tenant-scoped resources.
    if (tenantCtx) denyNotFound();
    return;
  }
  if (tenantCtx) {
    requireTenantContext(tenantCtx);
    const org = await prisma.organization.findFirst({
      where: { id: organizationId, tenantId: tenantCtx.tenantId },
      select: { id: true }
    });
    if (!org) denyNotFound();
    const allowed = await getAuthorizedOrganizationIds(userId, role, tenantCtx);
    if (!allowed.includes(organizationId)) denyNotFound();
    return;
  }
  denyNotFound();
}

/** Resources that have a resolvable organization ownership relationship. */
const ORG_SCOPED_RESOURCES = new Set([
  'organizations',
  'practices',
  'facilities',
  'providerOrganizations',
  'enrollments',
  'cases',
  'documents',
  'tasks',
  'providers'
]);

/** Resolve the organization id that owns a directory/workflow record, when possible. */
export async function resolveRecordOrganizationId(resource: string, id: string): Promise<string | null> {
  switch (resource) {
    case 'organizations':
      return id;
    case 'practices': {
      const row = await prisma.practice.findUnique({ where: { id }, select: { organizationId: true } });
      return row?.organizationId || null;
    }
    case 'facilities': {
      const row = await prisma.facility.findUnique({
        where: { id },
        select: { organizationId: true, practice: { select: { organizationId: true } } }
      });
      return row?.organizationId || row?.practice?.organizationId || null;
    }
    case 'providerOrganizations': {
      const row = await prisma.providerOrganization.findUnique({ where: { id }, select: { organizationId: true } });
      return row?.organizationId || null;
    }
    case 'providers': {
      // Prefer an explicit ProviderOrganization link; fall back to practice affiliations.
      // When multiple orgs exist, assertResourceRecordAccess checks the caller's allowed set separately.
      const viaOrg = await prisma.providerOrganization.findFirst({
        where: { providerId: id },
        select: { organizationId: true },
        orderBy: { createdAt: 'asc' }
      });
      if (viaOrg?.organizationId) return viaOrg.organizationId;
      const viaPractice = await prisma.providerPractice.findFirst({
        where: { providerId: id },
        select: { practice: { select: { organizationId: true } } }
      });
      return viaPractice?.practice?.organizationId || null;
    }
    case 'enrollments': {
      const row = await prisma.enrollmentApplication.findUnique({
        where: { id },
        select: {
          organizationId: true,
          practice: { select: { organizationId: true } },
          facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } }
        }
      });
      return row?.organizationId
        || row?.practice?.organizationId
        || row?.facility?.organizationId
        || row?.facility?.practice?.organizationId
        || null;
    }
    case 'cases': {
      const row = await prisma.credentialingCase.findUnique({
        where: { id },
        select: { practice: { select: { organizationId: true } } }
      });
      return row?.practice?.organizationId || null;
    }
    case 'documents': {
      const row = await prisma.document.findUnique({
        where: { id },
        select: {
          organizationId: true,
          practice: { select: { organizationId: true } },
          facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } },
          enrollment: {
            select: {
              organizationId: true,
              practice: { select: { organizationId: true } },
              facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } }
            }
          }
        }
      });
      return row?.organizationId
        || row?.practice?.organizationId
        || row?.facility?.organizationId
        || row?.facility?.practice?.organizationId
        || row?.enrollment?.organizationId
        || row?.enrollment?.practice?.organizationId
        || row?.enrollment?.facility?.organizationId
        || row?.enrollment?.facility?.practice?.organizationId
        || null;
    }
    case 'tasks': {
      const row = await prisma.task.findUnique({
        where: { id },
        select: {
          organizationId: true,
          practice: { select: { organizationId: true } },
          facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } },
          enrollment: { select: { organizationId: true } },
          credentialingCase: { select: { practice: { select: { organizationId: true } } } }
        }
      });
      return row?.organizationId
        || row?.practice?.organizationId
        || row?.facility?.organizationId
        || row?.facility?.practice?.organizationId
        || row?.enrollment?.organizationId
        || row?.credentialingCase?.practice?.organizationId
        || null;
    }
    default:
      return null;
  }
}

/**
 * SEC-09: After tenant validation, enforce organization ACL for org-scoped resources.
 * Does not trust organization IDs supplied by the frontend.
 */
export async function assertResourceRecordAccess(
  userId: string,
  role: Role,
  resource: string,
  id: string,
  tenantCtx?: TenantAuthContext | null
) {
  if (['payers', 'plans', 'employees'].includes(resource)) {
    // Platform-global reference / HR directories — platform role gates elsewhere.
    return;
  }
  if (tenantCtx) {
    await assertRecordInTenant(tenantCtx, resource, id);
    if (ORG_SCOPED_RESOURCES.has(resource)) {
      const allowed = await getAuthorizedOrganizationIds(userId, role, tenantCtx);
      const tenantOrgs = await getTenantOrganizationIds(tenantCtx.tenantId!);
      const isOrgRestricted = allowed.length < tenantOrgs.length;

      if (resource === 'providers') {
        // Allow if any linked organization is in the caller's authorized set.
        const links = await prisma.providerOrganization.findMany({
          where: { providerId: id },
          select: { organizationId: true }
        });
        const practiceLinks = await prisma.providerPractice.findMany({
          where: { providerId: id },
          select: { practice: { select: { organizationId: true } } }
        });
        const providerOrgIds = [
          ...links.map((l) => l.organizationId),
          ...practiceLinks.map((p) => p.practice?.organizationId).filter(Boolean) as string[]
        ];
        if (providerOrgIds.length) {
          if (!providerOrgIds.some((oid) => allowed.includes(oid))) denyNotFound();
        } else if (isOrgRestricted) {
          denyNotFound();
        }
        return;
      }

      const orgId = await resolveRecordOrganizationId(resource, id);
      if (orgId) {
        await assertOrganizationAccess(userId, role, orgId, tenantCtx);
      } else if (isOrgRestricted && resource !== 'licenses') {
        // Org-scoped resource missing ownership → deny for org-restricted clients.
        denyNotFound();
      }
    }
    return;
  }
  denyNotFound();
}

/**
 * List-filter helper: when the user has UserOrganization memberships, return authorized org ids.
 * Returns null when the user is not org-restricted (full tenant access).
 */
export async function getOrgRestrictionIds(
  userId: string,
  role: Role,
  tenantCtx?: TenantAuthContext | null
): Promise<string[] | null> {
  if (!tenantCtx?.tenantId) return null;
  const allowed = await getAuthorizedOrganizationIds(userId, role, tenantCtx);
  const tenantOrgs = await getTenantOrganizationIds(tenantCtx.tenantId);
  if (allowed.length >= tenantOrgs.length) return null;
  return allowed;
}

/** Prisma where fragment to restrict list results to authorized organizations. */
export function orgListWhereForResource(
  resource: string,
  organizationIds: string[]
): Record<string, unknown> | null {
  if (!organizationIds.length) return { id: '__none__' };
  const inOrgs = { in: organizationIds };
  switch (resource) {
    case 'organizations':
      return { id: inOrgs };
    case 'practices':
      return { organizationId: inOrgs };
    case 'facilities':
      return { OR: [{ organizationId: inOrgs }, { practice: { is: { organizationId: inOrgs } } }] };
    case 'providerOrganizations':
      return { organizationId: inOrgs };
    case 'providers':
      return {
        OR: [
          { organizations: { some: { organizationId: inOrgs } } },
          { practices: { some: { practice: { is: { organizationId: inOrgs } } } } }
        ]
      };
    case 'enrollments':
      return {
        OR: [
          { organizationId: inOrgs },
          { practice: { is: { organizationId: inOrgs } } },
          { facility: { is: { OR: [{ organizationId: inOrgs }, { practice: { is: { organizationId: inOrgs } } }] } } }
        ]
      };
    case 'cases':
      return { practice: { is: { organizationId: inOrgs } } };
    case 'documents':
      return {
        OR: [
          { organizationId: inOrgs },
          { practice: { is: { organizationId: inOrgs } } },
          { facility: { is: { OR: [{ organizationId: inOrgs }, { practice: { is: { organizationId: inOrgs } } }] } } },
          {
            enrollment: {
              is: {
                OR: [
                  { organizationId: inOrgs },
                  { practice: { is: { organizationId: inOrgs } } }
                ]
              }
            }
          }
        ]
      };
    case 'tasks':
      return {
        OR: [
          { organizationId: inOrgs },
          { practice: { is: { organizationId: inOrgs } } },
          { facility: { is: { OR: [{ organizationId: inOrgs }, { practice: { is: { organizationId: inOrgs } } }] } } },
          { enrollment: { is: { organizationId: inOrgs } } },
          { credentialingCase: { is: { practice: { is: { organizationId: inOrgs } } } } }
        ]
      };
    default:
      return null;
  }
}
