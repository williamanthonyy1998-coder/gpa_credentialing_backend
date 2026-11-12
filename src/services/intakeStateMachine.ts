import { IntakeStatus } from '@prisma/client';

/**
 * Explicit IntakeStatus transition policy (Phase 2C).
 * Frontend must not set arbitrary statuses; only dedicated transition endpoints.
 */
const TRANSITIONS: Record<IntakeStatus, IntakeStatus[]> = {
  [IntakeStatus.DRAFT]: [IntakeStatus.SENT, IntakeStatus.INVITED, IntakeStatus.CANCELLED],
  [IntakeStatus.SENT]: [IntakeStatus.INVITED, IntakeStatus.IN_PROGRESS, IntakeStatus.CANCELLED, IntakeStatus.EXPIRED],
  [IntakeStatus.INVITED]: [IntakeStatus.IN_PROGRESS, IntakeStatus.EXPIRED, IntakeStatus.CANCELLED],
  [IntakeStatus.IN_PROGRESS]: [IntakeStatus.SUBMITTED, IntakeStatus.CANCELLED, IntakeStatus.EXPIRED],
  [IntakeStatus.SUBMITTED]: [
    IntakeStatus.UNDER_REVIEW,
    IntakeStatus.CHANGES_REQUESTED,
    IntakeStatus.APPROVED,
    IntakeStatus.REJECTED,
    IntakeStatus.CANCELLED
  ],
  [IntakeStatus.UNDER_REVIEW]: [
    IntakeStatus.CHANGES_REQUESTED,
    IntakeStatus.APPROVED,
    IntakeStatus.REJECTED
  ],
  [IntakeStatus.CHANGES_REQUESTED]: [
    IntakeStatus.IN_PROGRESS,
    IntakeStatus.RESUBMITTED,
    IntakeStatus.CANCELLED,
    IntakeStatus.EXPIRED
  ],
  [IntakeStatus.RESUBMITTED]: [
    IntakeStatus.UNDER_REVIEW,
    IntakeStatus.CHANGES_REQUESTED,
    IntakeStatus.APPROVED,
    IntakeStatus.REJECTED
  ],
  [IntakeStatus.APPROVED]: [IntakeStatus.CONVERTED, IntakeStatus.CHANGES_REQUESTED],
  [IntakeStatus.REJECTED]: [],
  [IntakeStatus.CONVERTED]: [],
  [IntakeStatus.EXPIRED]: [],
  [IntakeStatus.CANCELLED]: []
};

export function allowedNextStatuses(from: IntakeStatus): IntakeStatus[] {
  return TRANSITIONS[from] || [];
}

export function canTransition(from: IntakeStatus, to: IntakeStatus): boolean {
  if (from === to) return false;
  return allowedNextStatuses(from).includes(to);
}

export function assertTransition(from: IntakeStatus, to: IntakeStatus, context = 'status change') {
  if (!canTransition(from, to)) {
    const err: any = new Error(`Invalid intake transition: ${from} → ${to} (${context})`);
    err.status = 400;
    err.code = 'INVALID_INTAKE_TRANSITION';
    err.from = from;
    err.to = to;
    throw err;
  }
}

export function isTerminal(status: IntakeStatus): boolean {
  return allowedNextStatuses(status).length === 0;
}

export function isEditableByProvider(status: IntakeStatus): boolean {
  return (
    status === IntakeStatus.DRAFT
    || status === IntakeStatus.INVITED
    || status === IntakeStatus.IN_PROGRESS
    || status === IntakeStatus.CHANGES_REQUESTED
  );
}

export function isSubmittableByProvider(status: IntakeStatus): boolean {
  return (
    status === IntakeStatus.INVITED
    || status === IntakeStatus.IN_PROGRESS
    || status === IntakeStatus.CHANGES_REQUESTED
  );
}

export function transitionMatrixForTests() {
  return { ...TRANSITIONS };
}
