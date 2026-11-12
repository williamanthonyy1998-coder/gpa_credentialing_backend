import { DataQualityIssueStatus, Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';

function deny(message: string, status = 400): never {
  const err: any = new Error(message);
  err.status = status;
  throw err;
}

const OPENISH: DataQualityIssueStatus[] = [
  DataQualityIssueStatus.OPEN,
  DataQualityIssueStatus.UNDER_REVIEW,
  DataQualityIssueStatus.REOPENED
];

export function canManagePlatformIssues(role: Role) {
  return ([Role.ADMIN, Role.CREDENTIALING_MANAGER] as Role[]).includes(role);
}

export function canManageTenantIssues(role: Role) {
  if (role === Role.CLIENT_USER || role === Role.EXTERNAL_PROVIDER) return false;
  return !([Role.READ_ONLY, Role.AUDITOR] as Role[]).includes(role);
}

export async function listDataQualityIssues(opts: {
  tenantId: string | null;
  platformAccess: boolean;
  status?: string;
  directoryType?: string;
  issueType?: string;
  severity?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25));
  const and: Prisma.DataQualityIssueWhereInput[] = [];

  if (opts.platformAccess && !opts.tenantId) {
    and.push({ tenantId: null });
  } else if (opts.tenantId) {
    // Tenant users see tenant issues + platform issues (read)
    and.push({
      OR: [{ tenantId: opts.tenantId }, { tenantId: null }]
    });
  } else {
    deny('Tenant context required', 403);
  }

  if (opts.status) and.push({ status: opts.status as DataQualityIssueStatus });
  if (opts.directoryType) and.push({ directoryType: opts.directoryType });
  if (opts.issueType) and.push({ issueType: opts.issueType as any });
  if (opts.severity) and.push({ severity: opts.severity as any });

  const where: Prisma.DataQualityIssueWhereInput = { AND: and };
  const [total, data] = await Promise.all([
    prisma.dataQualityIssue.count({ where }),
    prisma.dataQualityIssue.findMany({
      where,
      include: {
        assignedTo: { select: { id: true, name: true, email: true } },
        resolvedBy: { select: { id: true, name: true, email: true } }
      },
      orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize
    })
  ]);
  return { data, total, page, pageSize };
}

export async function getDataQualityIssue(
  id: string,
  opts: { tenantId: string | null; platformAccess: boolean }
) {
  const row = await prisma.dataQualityIssue.findUnique({
    where: { id },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      resolvedBy: { select: { id: true, name: true, email: true } }
    }
  });
  if (!row) deny('Issue not found', 404);
  if (row.tenantId == null) {
    // platform issue — readable with tenant or platform access
    return row;
  }
  if (!opts.tenantId || row.tenantId !== opts.tenantId) deny('Issue not found', 404);
  return row;
}

export async function updateDataQualityIssueStatus(input: {
  id: string;
  status: DataQualityIssueStatus;
  resolutionNotes?: string | null;
  assignedToId?: string | null;
  actorId: string;
  role: Role;
  tenantId: string | null;
  platformAccess: boolean;
}) {
  const row = await getDataQualityIssue(input.id, input);
  if (row.tenantId == null) {
    if (!canManagePlatformIssues(input.role)) {
      deny('Only platform administrators can resolve global directory issues', 403);
    }
  } else if (!canManageTenantIssues(input.role)) {
    deny('Your role cannot update quality issues', 403);
  }

  const next = input.status;
  const data: Prisma.DataQualityIssueUpdateInput = {
    status: next,
    resolutionNotes: input.resolutionNotes ?? row.resolutionNotes
  };
  if (input.assignedToId !== undefined) {
    data.assignedTo = input.assignedToId
      ? { connect: { id: input.assignedToId } }
      : { disconnect: true };
  }
  if (
    next === DataQualityIssueStatus.RESOLVED ||
    next === DataQualityIssueStatus.ACCEPTED_LEGITIMATE
  ) {
    data.resolvedAt = new Date();
    data.resolvedBy = { connect: { id: input.actorId } };
  }
  if (next === DataQualityIssueStatus.REOPENED || next === DataQualityIssueStatus.OPEN) {
    data.resolvedAt = null;
    data.resolvedBy = { disconnect: true };
  }

  return prisma.dataQualityIssue.update({
    where: { id: row.id },
    data,
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      resolvedBy: { select: { id: true, name: true, email: true } }
    }
  });
}

export async function markDuplicateDistinct(input: {
  directoryType: string;
  leftId: string;
  rightId: string;
  actorId: string;
  role: Role;
  tenantId: string | null;
  notes?: string | null;
}) {
  const [a, b] = input.leftId < input.rightId ? [input.leftId, input.rightId] : [input.rightId, input.leftId];
  const fingerprint = `dup:${input.directoryType}:${a}:${b}`;
  const existing = await prisma.dataQualityIssue.findUnique({ where: { fingerprint } });
  if (existing) {
    if (existing.tenantId && existing.tenantId !== input.tenantId) deny('Issue not found', 404);
    if (existing.tenantId == null && !canManagePlatformIssues(input.role)) {
      deny('Only platform administrators can resolve global directory issues', 403);
    }
    return prisma.dataQualityIssue.update({
      where: { id: existing.id },
      data: {
        status: DataQualityIssueStatus.ACCEPTED_LEGITIMATE,
        resolutionNotes: input.notes || 'Marked as distinct legitimate records',
        resolvedAt: new Date(),
        resolvedById: input.actorId
      }
    });
  }
  const tenantScoped = ['billingEntities', 'providers', 'documents', 'enrollments'].includes(input.directoryType);
  return prisma.dataQualityIssue.create({
    data: {
      tenantId: tenantScoped ? input.tenantId : null,
      issueType: 'DUPLICATE_POSSIBLE',
      severity: 'LOW',
      status: DataQualityIssueStatus.ACCEPTED_LEGITIMATE,
      directoryType: input.directoryType,
      recordId: a,
      relatedRecordId: b,
      fingerprint,
      title: `Accepted distinct pair (${input.directoryType})`,
      description: input.notes || 'Administrator confirmed records are distinct',
      resolvedAt: new Date(),
      resolvedById: input.actorId
    }
  });
}

export { OPENISH };
