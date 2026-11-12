import assert from 'node:assert/strict';
import test from 'node:test';
import { IntakeStatus } from '@prisma/client';
import {
  assertTransition,
  canTransition,
  isEditableByProvider,
  isSubmittableByProvider,
  isTerminal,
  transitionMatrixForTests
} from './intakeStateMachine';

test('state machine allows happy path transitions', () => {
  assert.equal(canTransition(IntakeStatus.DRAFT, IntakeStatus.INVITED), true);
  assert.equal(canTransition(IntakeStatus.INVITED, IntakeStatus.IN_PROGRESS), true);
  assert.equal(canTransition(IntakeStatus.IN_PROGRESS, IntakeStatus.SUBMITTED), true);
  assert.equal(canTransition(IntakeStatus.SUBMITTED, IntakeStatus.UNDER_REVIEW), true);
  assert.equal(canTransition(IntakeStatus.UNDER_REVIEW, IntakeStatus.CHANGES_REQUESTED), true);
  assert.equal(canTransition(IntakeStatus.CHANGES_REQUESTED, IntakeStatus.RESUBMITTED), true);
  assert.equal(canTransition(IntakeStatus.RESUBMITTED, IntakeStatus.APPROVED), true);
  assert.equal(canTransition(IntakeStatus.APPROVED, IntakeStatus.CONVERTED), true);
});

test('terminal statuses cannot transition', () => {
  assert.equal(isTerminal(IntakeStatus.CONVERTED), true);
  assert.equal(isTerminal(IntakeStatus.REJECTED), true);
  assert.equal(isTerminal(IntakeStatus.EXPIRED), true);
  assert.equal(isTerminal(IntakeStatus.CANCELLED), true);
  assert.throws(() => assertTransition(IntakeStatus.CONVERTED, IntakeStatus.APPROVED), /Invalid intake transition/);
  assert.throws(() => assertTransition(IntakeStatus.EXPIRED, IntakeStatus.SUBMITTED), /Invalid intake transition/);
});

test('invalid jumps are rejected', () => {
  assert.equal(canTransition(IntakeStatus.DRAFT, IntakeStatus.CONVERTED), false);
  assert.equal(canTransition(IntakeStatus.INVITED, IntakeStatus.APPROVED), false);
  assert.equal(canTransition(IntakeStatus.SUBMITTED, IntakeStatus.CONVERTED), false);
});

test('provider edit/submit gates match policy', () => {
  assert.equal(isEditableByProvider(IntakeStatus.IN_PROGRESS), true);
  assert.equal(isEditableByProvider(IntakeStatus.SUBMITTED), false);
  assert.equal(isSubmittableByProvider(IntakeStatus.CHANGES_REQUESTED), true);
  assert.equal(isSubmittableByProvider(IntakeStatus.APPROVED), false);
});

test('transition matrix covers every IntakeStatus key', () => {
  const matrix = transitionMatrixForTests();
  for (const status of Object.values(IntakeStatus)) {
    assert.ok(status in matrix, `missing transitions for ${status}`);
  }
});
