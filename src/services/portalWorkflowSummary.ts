/**
 * Phase 5C — read-only client portal SLA / follow-up summaries.
 * Scoped to UserOrganization memberships. No internal notes/escalations/policies.
 */
import { EnrollmentStatus, WorkflowSlaStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getAuthorizedOrganizationIds } from './orgAccess';
import { Role } from '@prisma/client';
import type { TenantAuthContext } from './tenantAccess';
import { TERMINAL } from './enrollmentLifecycle';

const CLIENT_SAFE_STATUSES = Object.values(EnrollmentStatus);

export async function getPortalWorkflowSummary(input: {
  userId: string;
  role: Role;
  tenantCtx: TenantAuthContext;
  organizationId?: string;
  providerId?: string;
  payerId?: string;
  status?: string;
  slaStatus?: string;
  from?: Date;
  to?: Date;
}) {
  const allowedOrgs = await getAuthorizedOrganizationIds(input.userId, input.role, input.tenantCtx);
  if (!allowedOrgs.length) {
    return {
      counts: emptyCounts(),
      items: [],
      organizations: [],
      note: 'No organization memberships assigned. Contact GPA to request access.'
    };
  }

  let orgIds = allowedOrgs;
  if (input.organizationId) {
    if (!allowedOrgs.includes(input.organizationId)) {
      const err: any = new Error('Organization not accessible');
      err.status = 403;
      throw err;
    }
    orgIds = [input.organizationId];
  }

  const and: any[] = [
    { tenantId: input.tenantCtx.tenantId },
    { organizationId: { in: orgIds } }
  ];
  if (input.providerId) and.push({ providerId: input.providerId });
  if (input.status && CLIENT_SAFE_STATUSES.includes(input.status as EnrollmentStatus)) {
    and.push({ status: input.status });
  }
  if (input.from || input.to) {
    const createdAt: any = {};
    if (input.from) createdAt.gte = input.from;
    if (input.to) createdAt.lte = input.to;
    and.push({ createdAt });
  }
  if (input.payerId) {
    and.push({ payerPlan: { is: { payerId: input.payerId } } });
  }

  const enrollments = await prisma.enrollmentApplication.findMany({
    where: { AND: and },
    select: {
      id: true,
      applicationNo: true,
      status: true,
      organizationId: true,
      providerId: true,
      lastFollowUpAt: true,
      nextFollowUpAt: true,
      submittedAt: true,
      createdAt: true,
      dueAt: true,
      organization: { select: { id: true, legalName: true, dba: true } },
      provider: { select: { id: true, firstName: true, lastName: true, npi: true } },
      payerPlan: { select: { id: true, name: true, payer: { select: { id: true, name: true } } } }
    },
    orderBy: [{ nextFollowUpAt: 'asc' }, { updatedAt: 'desc' }],
    take: 200
  });

  const enrollmentIds = enrollments.map((e) => e.id);
  const slaRows = enrollmentIds.length
    ? await prisma.workflowSlaRecord.findMany({
        where: {
          tenantId: input.tenantCtx.tenantId!,
          entityType: 'enrollment',
          entityId: { in: enrollmentIds },
          organizationId: { in: orgIds }
        },
        select: {
          entityId: true,
          slaStatus: true,
          expectedCompletionAt: true,
          daysRemaining: true,
          overdueDays: true
        }
      })
    : [];
  const slaMap = new Map(slaRows.map((s) => [s.entityId, s]));

  let items = enrollments.map((e) => {
    const sla = slaMap.get(e.id);
    return {
      id: e.id,
      applicationNo: e.applicationNo,
      status: e.status,
      organizationId: e.organizationId,
      organizationName: e.organization?.dba || e.organization?.legalName || null,
      providerId: e.providerId,
      providerName: e.provider
        ? `${e.provider.firstName || ''} ${e.provider.lastName || ''}`.trim()
        : null,
      payerName: e.payerPlan?.payer?.name || null,
      planName: e.payerPlan?.name || null,
      lastFollowUpAt: e.lastFollowUpAt,
      nextFollowUpAt: e.nextFollowUpAt,
      submittedAt: e.submittedAt,
      createdAt: e.createdAt,
      slaStatus: sla?.slaStatus || null,
      expectedCompletionAt: sla?.expectedCompletionAt || null,
      daysRemaining: sla?.daysRemaining ?? null,
      overdueDays: sla?.overdueDays ?? null
    };
  });

  if (input.slaStatus) {
    items = items.filter((i) => i.slaStatus === input.slaStatus);
  }

  const now = new Date();
  const pendingSet = new Set<EnrollmentStatus>([
    EnrollmentStatus.SUBMITTED,
    EnrollmentStatus.ACKNOWLEDGED,
    EnrollmentStatus.PAYER_REVIEW,
    EnrollmentStatus.ADDITIONAL_INFORMATION_NEEDED,
    EnrollmentStatus.PREPARING,
    EnrollmentStatus.READY_TO_SUBMIT
  ]);
  const completedSet = new Set<EnrollmentStatus>([
    EnrollmentStatus.APPROVED,
    EnrollmentStatus.EFFECTIVE,
    EnrollmentStatus.CLOSED
  ]);
  const active = items.filter((i) => !TERMINAL.includes(i.status as EnrollmentStatus));
  const pending = items.filter((i) => pendingSet.has(i.status as EnrollmentStatus));
  const upcomingFollowUps = items.filter(
    (i) => i.nextFollowUpAt && new Date(i.nextFollowUpAt) >= now && !TERMINAL.includes(i.status as EnrollmentStatus)
  );
  const overdue = items.filter(
    (i) =>
      (i.slaStatus === WorkflowSlaStatus.OVERDUE)
      || (i.nextFollowUpAt && new Date(i.nextFollowUpAt) < now && !TERMINAL.includes(i.status as EnrollmentStatus))
  );
  const completed = items.filter((i) => completedSet.has(i.status as EnrollmentStatus));

  const orgs = await prisma.organization.findMany({
    where: { id: { in: orgIds }, tenantId: input.tenantCtx.tenantId! },
    select: { id: true, legalName: true, dba: true, status: true },
    orderBy: { legalName: 'asc' }
  });

  return {
    counts: {
      activeEnrollments: active.length,
      pendingApplications: pending.length,
      upcomingFollowUps: upcomingFollowUps.length,
      overdueApplications: overdue.length,
      completedApplications: completed.length
    },
    items,
    organizations: orgs,
    note: 'Read-only workflow summary. Internal GPA notes, escalations, and automation policies are not exposed.'
  };
}

function emptyCounts() {
  return {
    activeEnrollments: 0,
    pendingApplications: 0,
    upcomingFollowUps: 0,
    overdueApplications: 0,
    completedApplications: 0
  };
}
