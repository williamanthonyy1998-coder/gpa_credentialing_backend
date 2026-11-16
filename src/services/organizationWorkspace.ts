/**
 * Phase 5A — Organization employee HR assignments + payer participation.
 * HR assignment is distinct from UserOrganization ACL and never grants access.
 */
import {
  OrganizationEmploymentStatus,
  OrganizationPayerParticipationStatus,
  Role
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { TenantAuthContext, requireTenantContext, denyNotFound } from './tenantAccess';
import { assertOrganizationAccess } from './orgAccess';

const MANAGE_ROLES: Role[] = [Role.ADMIN, Role.CREDENTIALING_MANAGER];

export function canManageOrganizationWorkspace(role: Role | string): boolean {
  return MANAGE_ROLES.includes(role as Role);
}

export function assertCanManageOrganizationWorkspace(role: Role | string) {
  if (!canManageOrganizationWorkspace(role)) {
    const err: any = new Error('Insufficient permissions to manage organization workspace assignments');
    err.status = 403;
    throw err;
  }
}

async function assertOrgInTenant(organizationId: string, tenantCtx: TenantAuthContext) {
  requireTenantContext(tenantCtx);
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, tenantId: tenantCtx.tenantId },
    select: { id: true }
  });
  if (!org) denyNotFound();
}

export async function assertOrgWorkspaceAccess(
  userId: string,
  role: Role,
  organizationId: string,
  tenantCtx: TenantAuthContext | null | undefined
) {
  requireTenantContext(tenantCtx || null);
  await assertOrgInTenant(organizationId, tenantCtx!);
  await assertOrganizationAccess(userId, role, organizationId, tenantCtx);
}

const employeeInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      department: true,
      jobTitle: true,
      employeeCode: true,
      phone: true
    }
  }
} as const;

export async function listOrganizationEmployees(input: {
  organizationId: string;
  department?: string | null;
  role?: string | null;
  employmentStatus?: OrganizationEmploymentStatus | null;
  q?: string | null;
}) {
  const where: any = { organizationId: input.organizationId };
  if (input.employmentStatus) where.employmentStatus = input.employmentStatus;
  if (input.department) where.department = { contains: input.department, mode: 'insensitive' };
  if (input.role || input.q) {
    where.user = {};
    if (input.role) where.user.role = input.role;
    if (input.q) {
      const q = input.q.trim();
      where.OR = [
        { department: { contains: q, mode: 'insensitive' } },
        { jobTitle: { contains: q, mode: 'insensitive' } },
        { responsibilities: { contains: q, mode: 'insensitive' } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { user: { employeeCode: { contains: q, mode: 'insensitive' } } }
      ];
    }
  }
  return prisma.organizationEmployee.findMany({
    where,
    include: employeeInclude,
    orderBy: [{ employmentStatus: 'asc' }, { createdAt: 'desc' }]
  });
}

export async function assignOrganizationEmployee(input: {
  organizationId: string;
  userId: string;
  department?: string | null;
  jobTitle?: string | null;
  employmentStatus?: OrganizationEmploymentStatus;
  responsibilities?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, role: true, active: true, department: true, jobTitle: true }
  });
  if (!user || !user.active) {
    const err: any = new Error('Employee user not found or inactive');
    err.status = 404;
    throw err;
  }
  // Do not allow assigning EXTERNAL_PROVIDER as org HR staff via this path.
  if (user.role === Role.EXTERNAL_PROVIDER) {
    const err: any = new Error('External provider accounts cannot be assigned as organization employees');
    err.status = 400;
    throw err;
  }

  try {
    return await prisma.organizationEmployee.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        department: input.department ?? user.department ?? null,
        jobTitle: input.jobTitle ?? user.jobTitle ?? null,
        employmentStatus: input.employmentStatus || OrganizationEmploymentStatus.ACTIVE,
        responsibilities: input.responsibilities || null,
        effectiveFrom: input.effectiveFrom || null,
        effectiveTo: input.effectiveTo || null
      },
      include: employeeInclude
    });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const err: any = new Error('This employee is already assigned to the organization');
      err.status = 409;
      err.code = 'DUPLICATE_ORG_EMPLOYEE';
      throw err;
    }
    throw e;
  }
}

export async function updateOrganizationEmployee(input: {
  organizationId: string;
  assignmentId: string;
  department?: string | null;
  jobTitle?: string | null;
  employmentStatus?: OrganizationEmploymentStatus;
  responsibilities?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}) {
  const existing = await prisma.organizationEmployee.findFirst({
    where: { id: input.assignmentId, organizationId: input.organizationId }
  });
  if (!existing) denyNotFound();
  return prisma.organizationEmployee.update({
    where: { id: input.assignmentId },
    data: {
      department: input.department === undefined ? undefined : input.department,
      jobTitle: input.jobTitle === undefined ? undefined : input.jobTitle,
      employmentStatus: input.employmentStatus,
      responsibilities: input.responsibilities === undefined ? undefined : input.responsibilities,
      effectiveFrom: input.effectiveFrom === undefined ? undefined : input.effectiveFrom,
      effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo
    },
    include: employeeInclude
  });
}

export async function removeOrganizationEmployee(organizationId: string, assignmentId: string) {
  const existing = await prisma.organizationEmployee.findFirst({
    where: { id: assignmentId, organizationId }
  });
  if (!existing) denyNotFound();
  // Remove HR assignment only — never touch UserOrganization ACL here.
  await prisma.organizationEmployee.delete({ where: { id: assignmentId } });
  return { ok: true, id: assignmentId };
}

const payerInclude = {
  payer: {
    select: {
      id: true,
      name: true,
      legalName: true,
      payerCode: true,
      payerType: true,
      status: true,
      plans: {
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, planCode: true, planType: true, status: true },
        orderBy: { name: 'asc' as const }
      }
    }
  },
  assignedContact: {
    select: { id: true, name: true, email: true, jobTitle: true }
  }
} as const;

export async function listOrganizationPayers(input: {
  organizationId: string;
  participationStatus?: OrganizationPayerParticipationStatus | null;
  renewalBefore?: Date | null;
  q?: string | null;
}) {
  const where: any = { organizationId: input.organizationId };
  if (input.participationStatus) where.participationStatus = input.participationStatus;
  if (input.renewalBefore) where.renewalDate = { lte: input.renewalBefore };
  if (input.q) {
    const q = input.q.trim();
    where.OR = [
      { contractReference: { contains: q, mode: 'insensitive' } },
      { notes: { contains: q, mode: 'insensitive' } },
      { payer: { name: { contains: q, mode: 'insensitive' } } },
      { payer: { payerCode: { contains: q, mode: 'insensitive' } } }
    ];
  }
  return prisma.organizationPayer.findMany({
    where,
    include: payerInclude,
    orderBy: [{ participationStatus: 'asc' }, { renewalDate: 'asc' }]
  });
}

export async function addOrganizationPayer(input: {
  organizationId: string;
  payerId: string;
  participationStatus?: OrganizationPayerParticipationStatus;
  contractReference?: string | null;
  effectiveDate?: Date | null;
  terminationDate?: Date | null;
  renewalDate?: Date | null;
  assignedContactId?: string | null;
  notes?: string | null;
}) {
  const payer = await prisma.payer.findUnique({ where: { id: input.payerId }, select: { id: true, status: true } });
  if (!payer) {
    const err: any = new Error('Payer not found');
    err.status = 404;
    throw err;
  }
  if (input.assignedContactId) {
    const contact = await prisma.user.findUnique({ where: { id: input.assignedContactId }, select: { id: true } });
    if (!contact) {
      const err: any = new Error('Assigned contact not found');
      err.status = 400;
      throw err;
    }
  }
  try {
    return await prisma.organizationPayer.create({
      data: {
        organizationId: input.organizationId,
        payerId: input.payerId,
        participationStatus: input.participationStatus || OrganizationPayerParticipationStatus.CONTRACTING,
        contractReference: input.contractReference || null,
        effectiveDate: input.effectiveDate || null,
        terminationDate: input.terminationDate || null,
        renewalDate: input.renewalDate || null,
        assignedContactId: input.assignedContactId || null,
        notes: input.notes || null
      },
      include: payerInclude
    });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const err: any = new Error('This payer is already linked to the organization');
      err.status = 409;
      err.code = 'DUPLICATE_ORG_PAYER';
      throw err;
    }
    throw e;
  }
}

export async function updateOrganizationPayer(input: {
  organizationId: string;
  relationshipId: string;
  participationStatus?: OrganizationPayerParticipationStatus;
  contractReference?: string | null;
  effectiveDate?: Date | null;
  terminationDate?: Date | null;
  renewalDate?: Date | null;
  assignedContactId?: string | null;
  notes?: string | null;
}) {
  const existing = await prisma.organizationPayer.findFirst({
    where: { id: input.relationshipId, organizationId: input.organizationId }
  });
  if (!existing) denyNotFound();
  if (input.assignedContactId) {
    const contact = await prisma.user.findUnique({ where: { id: input.assignedContactId }, select: { id: true } });
    if (!contact) {
      const err: any = new Error('Assigned contact not found');
      err.status = 400;
      throw err;
    }
  }
  return prisma.organizationPayer.update({
    where: { id: input.relationshipId },
    data: {
      participationStatus: input.participationStatus,
      contractReference: input.contractReference === undefined ? undefined : input.contractReference,
      effectiveDate: input.effectiveDate === undefined ? undefined : input.effectiveDate,
      terminationDate: input.terminationDate === undefined ? undefined : input.terminationDate,
      renewalDate: input.renewalDate === undefined ? undefined : input.renewalDate,
      assignedContactId: input.assignedContactId === undefined ? undefined : input.assignedContactId,
      notes: input.notes === undefined ? undefined : input.notes
    },
    include: payerInclude
  });
}

export async function removeOrganizationPayer(organizationId: string, relationshipId: string) {
  const existing = await prisma.organizationPayer.findFirst({
    where: { id: relationshipId, organizationId }
  });
  if (!existing) denyNotFound();
  // Soft-business rule: active contracts should be terminated rather than hard-deleted when possible.
  if (
    existing.participationStatus === OrganizationPayerParticipationStatus.ACTIVE
    || existing.participationStatus === OrganizationPayerParticipationStatus.CONTRACTED
  ) {
    return prisma.organizationPayer.update({
      where: { id: relationshipId },
      data: {
        participationStatus: OrganizationPayerParticipationStatus.TERMINATED,
        terminationDate: existing.terminationDate || new Date()
      },
      include: payerInclude
    });
  }
  await prisma.organizationPayer.delete({ where: { id: relationshipId } });
  return { ok: true, id: relationshipId, deleted: true };
}

export async function getOrganizationWorkspaceSummary(organizationId: string) {
  const now = new Date();
  const renewalHorizon = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const activeEnrollmentStatuses = [
    'PREPARING', 'READY_TO_SUBMIT', 'SUBMITTED', 'ACKNOWLEDGED', 'PAYER_REVIEW',
    'ADDITIONAL_INFORMATION_NEEDED', 'APPROVED', 'EFFECTIVE'
  ] as const;
  const pendingCaseStatuses = [
    'DRAFT', 'INFORMATION_NEEDED', 'UNDER_REVIEW', 'VERIFICATION_PENDING', 'READY_FOR_APPROVAL', 'ON_HOLD'
  ] as const;

  const [
    practices,
    facilities,
    providers,
    enrollmentsActive,
    casesPending,
    documents,
    tasksOpen,
    tasksOverdue,
    employeesTotal,
    employeesActive,
    payersTotal,
    payersActive,
    payersContracting,
    payersRenewal
  ] = await Promise.all([
    prisma.practice.count({ where: { organizationId } }),
    prisma.facility.count({
      where: { OR: [{ organizationId }, { practice: { is: { organizationId } } }] }
    }),
    prisma.providerOrganization.count({ where: { organizationId, status: 'ACTIVE' } }),
    prisma.enrollmentApplication.count({
      where: { organizationId, status: { in: [...activeEnrollmentStatuses] as any } }
    }),
    prisma.credentialingCase.count({
      where: {
        status: { in: [...pendingCaseStatuses] as any },
        OR: [
          { practice: { is: { organizationId } } },
          { provider: { is: { organizations: { some: { organizationId } } } } }
        ]
      }
    }),
    prisma.document.count({ where: { organizationId, securityStatus: { not: 'DELETED' } } }),
    prisma.task.count({
      where: {
        organizationId,
        status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }
      }
    }),
    prisma.task.count({
      where: {
        organizationId,
        status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] },
        dueAt: { lt: now }
      }
    }),
    prisma.organizationEmployee.count({ where: { organizationId } }),
    prisma.organizationEmployee.count({
      where: { organizationId, employmentStatus: OrganizationEmploymentStatus.ACTIVE }
    }),
    prisma.organizationPayer.count({ where: { organizationId } }),
    prisma.organizationPayer.count({
      where: {
        organizationId,
        participationStatus: {
          in: [
            OrganizationPayerParticipationStatus.ACTIVE,
            OrganizationPayerParticipationStatus.CONTRACTED
          ]
        }
      }
    }),
    prisma.organizationPayer.count({
      where: {
        organizationId,
        participationStatus: {
          in: [
            OrganizationPayerParticipationStatus.CONTRACTING,
            OrganizationPayerParticipationStatus.PENDING_RENEWAL,
            OrganizationPayerParticipationStatus.NOT_CONTRACTED
          ]
        }
      }
    }),
    prisma.organizationPayer.count({
      where: {
        organizationId,
        renewalDate: { gte: now, lte: renewalHorizon },
        participationStatus: {
          notIn: [
            OrganizationPayerParticipationStatus.TERMINATED,
            OrganizationPayerParticipationStatus.SUSPENDED
          ]
        }
      }
    })
  ]);

  return {
    practices,
    facilities,
    providers,
    enrollmentsActive,
    casesPending,
    documents,
    tasksOpen,
    tasksOverdue,
    employeesTotal,
    employeesActive,
    payersTotal,
    payersActive,
    payersContracting,
    payersRenewal
  };
}

/** Candidate employees for assignment — GPA/staff users only; never CLIENT_USER grant escalation. */
export async function listAssignableEmployees(tenantCtx: TenantAuthContext) {
  requireTenantContext(tenantCtx);
  // Global employee directory remains platform-scoped; filter to staff roles.
  return prisma.user.findMany({
    where: {
      active: true,
      role: {
        in: [
          Role.ADMIN,
          Role.CREDENTIALING_MANAGER,
          Role.CREDENTIALING_SPECIALIST,
          Role.ENROLLMENT_SPECIALIST,
          Role.APPROVER,
          Role.AUDITOR,
          Role.READ_ONLY
        ]
      }
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      department: true,
      jobTitle: true,
      employeeCode: true
    },
    orderBy: { name: 'asc' },
    take: 500
  });
}

export async function listOrganizationEmployeeTasks(organizationId: string, userId: string) {
  return prisma.task.findMany({
    where: {
      organizationId,
      assignedToId: userId,
      status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] }
    },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      dueAt: true
    },
    orderBy: { dueAt: 'asc' },
    take: 50
  });
}
