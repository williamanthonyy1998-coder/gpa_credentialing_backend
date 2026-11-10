import { CaseStatus, EnrollmentStatus, Role } from '@prisma/client';

/** Keep Prisma enum values; map UI labels separately on the frontend. */
export const ENROLLMENT_TRANSITIONS: Record<EnrollmentStatus, EnrollmentStatus[]> = {
  NOT_STARTED: ['PREPARING', 'WITHDRAWN'],
  PREPARING: ['READY_TO_SUBMIT', 'NOT_STARTED', 'WITHDRAWN'],
  READY_TO_SUBMIT: ['SUBMITTED', 'PREPARING', 'WITHDRAWN'],
  SUBMITTED: ['PAYER_REVIEW', 'ADDITIONAL_INFORMATION_NEEDED', 'WITHDRAWN'],
  PAYER_REVIEW: ['ADDITIONAL_INFORMATION_NEEDED', 'APPROVED', 'DENIED', 'WITHDRAWN'],
  ADDITIONAL_INFORMATION_NEEDED: ['PREPARING', 'READY_TO_SUBMIT', 'SUBMITTED', 'WITHDRAWN'],
  APPROVED: [],
  DENIED: [],
  WITHDRAWN: []
};

export const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  DRAFT: ['INFORMATION_NEEDED', 'UNDER_REVIEW', 'ON_HOLD'],
  INFORMATION_NEEDED: ['UNDER_REVIEW', 'ON_HOLD', 'DRAFT'],
  UNDER_REVIEW: ['VERIFICATION_PENDING', 'INFORMATION_NEEDED', 'READY_FOR_APPROVAL', 'ON_HOLD'],
  VERIFICATION_PENDING: ['READY_FOR_APPROVAL', 'INFORMATION_NEEDED', 'ON_HOLD'],
  READY_FOR_APPROVAL: ['APPROVED', 'REJECTED', 'UNDER_REVIEW', 'ON_HOLD'],
  APPROVED: [],
  REJECTED: [],
  ON_HOLD: ['DRAFT', 'INFORMATION_NEEDED', 'UNDER_REVIEW']
};

const FINAL_ENROLLMENT: EnrollmentStatus[] = ['APPROVED', 'DENIED'];
const FINAL_CASE: CaseStatus[] = ['APPROVED', 'REJECTED'];
const APPROVER_ROLES: Role[] = [Role.ADMIN, Role.CREDENTIALING_MANAGER, Role.APPROVER];

export function allowedEnrollmentTransitions(from: EnrollmentStatus, role: Role): EnrollmentStatus[] {
  const next = ENROLLMENT_TRANSITIONS[from] || [];
  if (APPROVER_ROLES.includes(role)) return next;
  return next.filter(s => !FINAL_ENROLLMENT.includes(s));
}

export function allowedCaseTransitions(from: CaseStatus, role: Role): CaseStatus[] {
  const next = CASE_TRANSITIONS[from] || [];
  if (APPROVER_ROLES.includes(role)) return next;
  return next.filter(s => !FINAL_CASE.includes(s));
}

export function assertEnrollmentTransition(from: EnrollmentStatus, to: EnrollmentStatus, role: Role) {
  if (from === to) return;
  const allowed = allowedEnrollmentTransitions(from, role);
  if (!allowed.includes(to)) {
    const err: any = new Error(`Status change from ${from} to ${to} is not allowed for your role`);
    err.status = 400;
    throw err;
  }
  if (FINAL_ENROLLMENT.includes(to) && !APPROVER_ROLES.includes(role)) {
    const err: any = new Error('Only an authorized approver can finalize this enrollment');
    err.status = 403;
    throw err;
  }
}

export function assertCaseTransition(from: CaseStatus, to: CaseStatus, role: Role) {
  if (from === to) return;
  const allowed = allowedCaseTransitions(from, role);
  if (!allowed.includes(to)) {
    const err: any = new Error(`Status change from ${from} to ${to} is not allowed for your role`);
    err.status = 400;
    throw err;
  }
  if (FINAL_CASE.includes(to) && !APPROVER_ROLES.includes(role)) {
    const err: any = new Error('Only an authorized approver can finalize this case');
    err.status = 403;
    throw err;
  }
}

export function daysConsumed(from: Date | string | null | undefined, to: Date = new Date()): number | null {
  if (!from) return null;
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((to.getTime() - start) / (24 * 60 * 60 * 1000)));
}
