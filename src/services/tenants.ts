import {
  Prisma,
  Role,
  TenantMembershipStatus,
  TenantRole,
  TenantStatus
} from '@prisma/client';
import { prisma } from '../lib/prisma';

export type CreateTenantInput = {
  id?: string;
  name: string;
  slug: string;
  status?: TenantStatus;
};

export type CreateTenantMembershipInput = {
  id?: string;
  userId: string;
  tenantId: string;
  role: TenantRole;
  status?: TenantMembershipStatus;
};

export function normalizeTenantSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Platform GPA administrators are identified by User.role, not tenant membership. */
export function isPlatformAdmin(role: Role): boolean {
  return role === Role.ADMIN;
}

/** Membership in one tenant never implies access to another tenant. */
export function membershipGrantsTenantAccess(
  memberships: Array<{ tenantId: string; status: TenantMembershipStatus }>,
  tenantId: string
): boolean {
  return memberships.some(
    (m) => m.tenantId === tenantId && m.status === TenantMembershipStatus.ACTIVE
  );
}

export function assertActiveMembership(
  memberships: Array<{ tenantId: string; status: TenantMembershipStatus; role: TenantRole }>,
  tenantId: string
): { tenantId: string; status: TenantMembershipStatus; role: TenantRole } {
  const match = memberships.find((m) => m.tenantId === tenantId);
  if (!match) {
    const err: any = new Error('User is not a member of this tenant');
    err.code = 'TENANT_MEMBERSHIP_MISSING';
    err.status = 403;
    throw err;
  }
  if (match.status !== TenantMembershipStatus.ACTIVE) {
    const err: any = new Error(`Tenant membership is ${match.status}`);
    err.code = 'TENANT_MEMBERSHIP_INACTIVE';
    err.status = 403;
    throw err;
  }
  return match;
}

export async function createTenant(input: CreateTenantInput) {
  const slug = normalizeTenantSlug(input.slug);
  if (!slug) {
    const err: any = new Error('Tenant slug is required');
    err.code = 'TENANT_SLUG_INVALID';
    err.status = 400;
    throw err;
  }
  if (!input.name?.trim()) {
    const err: any = new Error('Tenant name is required');
    err.code = 'TENANT_NAME_INVALID';
    err.status = 400;
    throw err;
  }

  try {
    return await prisma.tenant.create({
      data: {
        id: input.id,
        name: input.name.trim(),
        slug,
        status: input.status ?? TenantStatus.ACTIVE
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const err: any = new Error('Tenant slug already exists');
      err.code = 'TENANT_SLUG_CONFLICT';
      err.status = 409;
      throw err;
    }
    throw error;
  }
}

export async function createTenantMembership(input: CreateTenantMembershipInput) {
  try {
    return await prisma.tenantMembership.create({
      data: {
        id: input.id,
        userId: input.userId,
        tenantId: input.tenantId,
        role: input.role,
        status: input.status ?? TenantMembershipStatus.ACTIVE
      }
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const err: any = new Error('User is already a member of this tenant');
      err.code = 'TENANT_MEMBERSHIP_CONFLICT';
      err.status = 409;
      throw err;
    }
    throw error;
  }
}

export async function upsertTenantMembership(input: CreateTenantMembershipInput) {
  return prisma.tenantMembership.upsert({
    where: {
      userId_tenantId: {
        userId: input.userId,
        tenantId: input.tenantId
      }
    },
    update: {
      role: input.role,
      status: input.status ?? TenantMembershipStatus.ACTIVE,
      ...(input.id ? { id: input.id } : {})
    },
    create: {
      id: input.id,
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role,
      status: input.status ?? TenantMembershipStatus.ACTIVE
    }
  });
}

export async function listUserTenantMemberships(userId: string) {
  return prisma.tenantMembership.findMany({
    where: { userId },
    include: { tenant: true },
    orderBy: { createdAt: 'asc' }
  });
}
