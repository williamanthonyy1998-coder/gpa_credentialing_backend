import { Role } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Multi-org BPO default: staff with no UserOrganization rows retain global access.
 * When memberships exist, non-ADMIN users are limited to those organizations.
 * ADMIN always bypasses membership checks.
 */
export async function getAuthorizedOrganizationIds(userId: string, role: Role): Promise<string[] | null> {
  if (role === Role.ADMIN) return null;
  const memberships = await prisma.userOrganization.findMany({
    where: { userId },
    select: { organizationId: true }
  });
  if (!memberships.length) return null; // global staff (current seed behavior)
  return memberships.map(m => m.organizationId);
}

export function orgScopeWhere(organizationIds: string[] | null): any | undefined {
  if (!organizationIds) return undefined;
  return { in: organizationIds };
}

export async function assertOrganizationAccess(userId: string, role: Role, organizationId: string | null | undefined) {
  if (!organizationId) return;
  const allowed = await getAuthorizedOrganizationIds(userId, role);
  if (!allowed) return;
  if (!allowed.includes(organizationId)) {
    const err: any = new Error('You do not have access to this organization');
    err.status = 403;
    throw err;
  }
}

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
          facility: { select: { organizationId: true, practice: { select: { organizationId: true } } } }
        }
      });
      return row?.organizationId
        || row?.practice?.organizationId
        || row?.facility?.organizationId
        || row?.facility?.practice?.organizationId
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

export async function assertResourceRecordAccess(userId: string, role: Role, resource: string, id: string) {
  const orgId = await resolveRecordOrganizationId(resource, id);
  await assertOrganizationAccess(userId, role, orgId);
}
