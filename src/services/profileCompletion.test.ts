import assert from 'node:assert/strict';
import test from 'node:test';
import { profileCompletion } from './profileCompletion';

test('provider completion uses required fields', () => {
  const incomplete = profileCompletion('provider', { firstName: 'A', lastName: 'B' });
  assert.ok(incomplete.percent < 100);
  assert.ok(incomplete.missing.includes('NPI'));

  const complete = profileCompletion('provider', {
    firstName: 'A',
    lastName: 'B',
    npi: '123',
    dateOfBirth: new Date(),
    email: 'a@b.com',
    primarySpecialty: 'FM',
    taxonomyCode: '207Q',
    professionalType: 'MD'
  });
  assert.equal(complete.percent, 100);
  assert.equal(complete.missing.length, 0);
});

test('practice owners presence counts when configured', () => {
  const withoutOwners = profileCompletion('practice', {
    name: 'P', organizationId: 'o1', npi: '1', taxId: 't', taxonomyCode: 'x',
    contactName: 'c', phone: '1', email: 'a@b.com', mailingAddress: { city: 'X' }
  });
  assert.equal(withoutOwners.percent, 100);

  const withRequiredGap = profileCompletion('practice', { name: 'P' });
  assert.ok(withRequiredGap.missing.length > 0);
});
