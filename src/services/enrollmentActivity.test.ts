import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '@prisma/client';
import {
  canDeleteEnrollmentActivity,
  canEditEnrollmentActivity,
  canWriteEnrollmentActivity,
  ENROLLMENT_ACTIVITY_TYPES
} from './enrollmentActivity';

describe('enrollmentActivity permissions', () => {
  it('blocks read-only and auditor from writing', () => {
    assert.equal(canWriteEnrollmentActivity(Role.READ_ONLY), false);
    assert.equal(canWriteEnrollmentActivity(Role.AUDITOR), false);
    assert.equal(canWriteEnrollmentActivity(Role.ENROLLMENT_SPECIALIST), true);
    assert.equal(canWriteEnrollmentActivity(Role.ADMIN), true);
  });

  it('allows authors and managers to edit/delete', () => {
    assert.equal(canEditEnrollmentActivity(Role.ENROLLMENT_SPECIALIST, 'u1', 'u1'), true);
    assert.equal(canEditEnrollmentActivity(Role.ENROLLMENT_SPECIALIST, 'u1', 'u2'), false);
    assert.equal(canEditEnrollmentActivity(Role.ADMIN, 'u1', 'u2'), true);
    assert.equal(canDeleteEnrollmentActivity(Role.CREDENTIALING_MANAGER, 'u1', 'u2'), true);
    assert.equal(canDeleteEnrollmentActivity(Role.READ_ONLY, 'u1', 'u1'), false);
  });

  it('exports expected activity types', () => {
    assert.ok(ENROLLMENT_ACTIVITY_TYPES.includes('MESSAGE'));
    assert.ok(ENROLLMENT_ACTIVITY_TYPES.includes('FOLLOW_UP_COMPLETED'));
    assert.ok(ENROLLMENT_ACTIVITY_TYPES.includes('FOLLOW_UP_SCHEDULED'));
    assert.ok(ENROLLMENT_ACTIVITY_TYPES.includes('STATUS_CHANGE'));
    assert.ok(ENROLLMENT_ACTIVITY_TYPES.includes('APPROVAL_UPDATE'));
  });
});
