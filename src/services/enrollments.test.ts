import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrollmentAssigneeDisplayName,
  enrollmentFacilityDisplayName,
  enrollmentProviderDisplayName,
  enrollmentSubjectDisplay,
  providerNameFromParts
} from './enrollments';
import { daysConsumed } from './workflow';

test('providerNameFromParts prefers full name then NPI', () => {
  assert.equal(providerNameFromParts('Jane', 'Doe', '123'), 'Jane Doe');
  assert.equal(providerNameFromParts('', '', '1234567890'), '1234567890');
  assert.equal(providerNameFromParts(null, null, null), '');
});

test('provider display uses provider when assigned', () => {
  const name = enrollmentProviderDisplayName({
    provider: { firstName: 'Demo', lastName: 'Family', npi: '111' },
    facility: { name: 'Main Clinic' }
  });
  assert.equal(name, 'Demo Family');
});

test('provider display falls back to facility when provider missing', () => {
  const name = enrollmentProviderDisplayName({
    provider: null,
    facility: { name: 'West Facility' }
  });
  assert.equal(name, 'West Facility');
});

test('provider display never returns blank for legacy practice-only rows', () => {
  assert.equal(
    enrollmentProviderDisplayName({ provider: null, facility: null, practice: { name: 'Legacy Practice' } }),
    'Legacy Practice'
  );
  assert.equal(enrollmentProviderDisplayName({}), '—');
});

test('facility display prefers facility then practice', () => {
  assert.equal(enrollmentFacilityDisplayName({ facility: { name: 'Fac A' }, practice: { name: 'Prac' } }), 'Fac A');
  assert.equal(enrollmentFacilityDisplayName({ facility: null, practice: { name: 'Prac' } }), 'Prac');
  assert.equal(enrollmentFacilityDisplayName({}), '—');
});

test('subject display prefers explicit subject field', () => {
  assert.equal(
    enrollmentSubjectDisplay({
      subject: 'BCBS Group App',
      provider: { firstName: 'A', lastName: 'B' },
      facility: { name: 'Fac' }
    }),
    'BCBS Group App'
  );
  assert.equal(
    enrollmentSubjectDisplay({
      subject: '  ',
      provider: null,
      facility: { name: 'Fac Only' }
    }),
    'Fac Only'
  );
});

test('assignee display resolves mapped user name then falls back to email', () => {
  const map = new Map([
    ['enrollment@example.com', { id: 'u1', name: 'Enrollment Specialist', email: 'enrollment@example.com' }]
  ]);
  assert.equal(enrollmentAssigneeDisplayName('enrollment@example.com', map), 'Enrollment Specialist');
  assert.equal(enrollmentAssigneeDisplayName('unknown@example.com', map), 'unknown@example.com');
  assert.equal(enrollmentAssigneeDisplayName(null, map), '—');
});

test('daysConsumed uses enrollment start date and never goes negative', () => {
  const start = new Date('2026-11-01T00:00:00.000Z');
  const end = new Date('2026-11-10T00:00:00.000Z');
  assert.equal(daysConsumed(start, end), 9);
  assert.equal(daysConsumed(null, end), null);
  assert.equal(daysConsumed(end, start), 0);
});
