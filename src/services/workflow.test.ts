import assert from 'node:assert/strict';
import test from 'node:test';
import { Role } from '@prisma/client';
import {
  allowedEnrollmentTransitions,
  assertEnrollmentTransition,
  assertCaseTransition,
  daysConsumed
} from './workflow';

test('enrollment specialist cannot approve', () => {
  const allowed = allowedEnrollmentTransitions('PAYER_REVIEW', Role.ENROLLMENT_SPECIALIST);
  assert.ok(!allowed.includes('APPROVED'));
  assert.ok(!allowed.includes('DENIED'));
  assert.throws(
    () => assertEnrollmentTransition('PAYER_REVIEW', 'APPROVED', Role.ENROLLMENT_SPECIALIST),
    /not allowed|approver/i
  );
});

test('approver can approve from payer review', () => {
  assert.doesNotThrow(() => assertEnrollmentTransition('PAYER_REVIEW', 'APPROVED', Role.APPROVER));
});

test('invalid enrollment jump is rejected', () => {
  assert.throws(
    () => assertEnrollmentTransition('NOT_STARTED', 'APPROVED', Role.ADMIN),
    /not allowed/i
  );
});

test('case ready for approval can be approved by manager', () => {
  assert.doesNotThrow(() => assertCaseTransition('READY_FOR_APPROVAL', 'APPROVED', Role.CREDENTIALING_MANAGER));
});

test('daysConsumed counts whole days', () => {
  const start = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const days = daysConsumed(start);
  assert.equal(days, 3);
  assert.equal(daysConsumed(null), null);
});
