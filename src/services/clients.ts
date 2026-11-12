import {
  Prisma,
  Role,
  TenantOnboardingStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createTenant, normalizeTenantSlug } from './tenants';

function deny(message: string, status = 400): never {
  const err: any = new Error(message);
  err.status = status;
  throw err;
}

export function assertGpaClientAdmin(role: Role) {
  if (role !== Role.ADMIN && role !== Role.CREDENTIALING_MANAGER) {
    deny('Insufficient permissions', 403);
  }
}

export function sanitizeClientForPortal(tenant: any) {
  if (!tenant) return tenant;
  const { internalNotes, ...safe } = tenant;
  return safe;
}

export async function createClientAccount(input: {
  name: string;
  slug?: string;
  primaryContactName?: string | null;
  primaryContactEmail?: string | null;
  primaryContactPhone?: string | null;
  internalNotes?: string | null;
  status?: TenantStatus;
}) {
  const slug = normalizeTenantSlug(input.slug || input.name);
  const tenant = await createTenant({
    name: input.name,
    slug,
    status: input.status ?? TenantStatus.ACTIVE
  });
  return prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      onboardingStatus: TenantOnboardingStatus.NOT_STARTED,
      primaryContactName: input.primaryContactName || null,
      primaryContactEmail: input.primaryContactEmail?.toLowerCase() || null,
      primaryContactPhone: input.primaryContactPhone || null,
      internalNotes: input.internalNotes || null
    }
  });
}

export async function updateClientAccount(
  id: string,
  input: {
    name?: string;
    slug?: string;
    primaryContactName?: string | null;
    primaryContactEmail?: string | null;
    primaryContactPhone?: string | null;
    internalNotes?: string | null;
    status?: TenantStatus;
    onboardingStatus?: TenantOnboardingStatus;
  },
  opts: { includeInternalNotes: boolean }
) {
  const data: Prisma.TenantUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.slug !== undefined) data.slug = normalizeTenantSlug(input.slug);
  if (input.primaryContactName !== undefined) data.primaryContactName = input.primaryContactName;
  if (input.primaryContactEmail !== undefined) {
    data.primaryContactEmail = input.primaryContactEmail?.toLowerCase() || null;
  }
  if (input.primaryContactPhone !== undefined) data.primaryContactPhone = input.primaryContactPhone;
  if (input.internalNotes !== undefined && opts.includeInternalNotes) {
    data.internalNotes = input.internalNotes;
  }
  if (input.status !== undefined) {
    data.status = input.status;
    if (input.status === TenantStatus.SUSPENDED) {
      data.onboardingStatus = TenantOnboardingStatus.SUSPENDED;
    }
  }
  if (input.onboardingStatus !== undefined) data.onboardingStatus = input.onboardingStatus;

  try {
    const row = await prisma.tenant.update({ where: { id }, data });
    return opts.includeInternalNotes ? row : sanitizeClientForPortal(row);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      deny('Client account not found', 404);
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      deny('Client slug already exists', 409);
    }
    throw e;
  }
}

export async function getClientDetail(id: string, opts: { includeInternalNotes: boolean }) {
  const row = await prisma.tenant.findUnique({
    where: { id },
    include: {
      memberships: {
        include: { user: { select: { id: true, name: true, email: true, role: true, active: true } } },
        orderBy: { createdAt: 'asc' }
      },
      invitations: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          deliveryStatus: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          lastSentAt: true,
          createdAt: true
        }
      },
      organizations: {
        select: { id: true, legalName: true, dba: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100
      },
      _count: {
        select: {
          memberships: true,
          organizations: true,
          invitations: true,
          providers: true
        }
      }
    }
  });
  if (!row) deny('Client account not found', 404);
  return opts.includeInternalNotes ? row : sanitizeClientForPortal(row);
}

export async function listClientAccounts(opts: { q?: string; status?: TenantStatus; page?: number; pageSize?: number }) {
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25));
  const where: Prisma.TenantWhereInput = {};
  if (opts.status) where.status = opts.status;
  if (opts.q?.trim()) {
    const q = opts.q.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { primaryContactEmail: { contains: q, mode: 'insensitive' } }
    ];
  }
  const [total, data] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { memberships: true, organizations: true, invitations: true } }
      }
    })
  ]);
  return { data, total, page, pageSize };
}

export function canManageTenantUsers(tenantRole: TenantRole | null | undefined) {
  return tenantRole === TenantRole.TENANT_ADMIN || tenantRole === TenantRole.CREDENTIALING_MANAGER;
}

export function canWriteTenantRecords(tenantRole: TenantRole | null | undefined) {
  if (!tenantRole) return false;
  return tenantRole !== TenantRole.READ_ONLY && tenantRole !== TenantRole.AUDITOR;
}

export async function getPortalDashboard(tenantId: string) {
  const [
    tenant,
    orgCount,
    practiceCount,
    facilityCount,
    memberCount,
    pendingInvites,
    recentAudit
  ] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        onboardingStatus: true,
        primaryContactName: true,
        primaryContactEmail: true,
        primaryContactPhone: true,
        createdAt: true,
        updatedAt: true
      }
    }),
    prisma.organization.count({ where: { tenantId } }),
    prisma.practice.count({ where: { organization: { is: { tenantId } } } }),
    prisma.facility.count({
      where: {
        OR: [
          { organization: { is: { tenantId } } },
          { practice: { is: { organization: { is: { tenantId } } } } }
        ]
      }
    }),
    prisma.tenantMembership.count({ where: { tenantId, status: 'ACTIVE' } }),
    prisma.tenantInvitation.count({ where: { tenantId, status: 'PENDING' } }),
    prisma.auditEvent.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
        actor: { select: { name: true, email: true } }
      }
    })
  ]);
  if (!tenant) deny('Client account not found', 404);
  return {
    tenant,
    counts: {
      organizations: orgCount,
      practices: practiceCount,
      facilities: facilityCount,
      activeUsers: memberCount,
      pendingInvitations: pendingInvites
    },
    recentActivity: recentAudit,
    modules: {
      credentials: { available: true, note: 'Use Credentials within your tenant workspace' },
      enrollments: { available: true, note: 'Use Enrollments within your tenant workspace' },
      providerExternalIntake: { available: true, note: 'Use Provider intakes in the client portal' }
    }
  };
}
