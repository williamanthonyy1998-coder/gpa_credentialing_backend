import test from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the facility sidebar mapping used by FacilityProfile / DirectoryEntityNav. */
function mapFacilityProviders(rows: Array<{ provider?: any; providerId?: string; facilityId?: string }>) {
  return rows
    .map(a => a.provider || (a.providerId ? { id: a.providerId } : null))
    .filter(Boolean)
    .map((p: any) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      primarySpecialty: p.primarySpecialty,
      status: p.status
    }));
}

test('maps only the selected facility affiliations into sidebar providers', () => {
  const facilityA = [
    {
      providerId: 'p1',
      facilityId: 'fA',
      provider: { id: 'p1', firstName: 'Demo', lastName: 'Family', primarySpecialty: 'Family Medicine', status: 'ACTIVE' }
    },
    {
      providerId: 'p2',
      facilityId: 'fA',
      provider: { id: 'p2', firstName: 'Demo', lastName: 'Primary', primarySpecialty: 'Internal Medicine', status: 'PENDING' }
    }
  ];
  const facilityB = [
    {
      providerId: 'p3',
      facilityId: 'fB',
      provider: { id: 'p3', firstName: 'Demo', lastName: 'Behavioral', primarySpecialty: 'Psychiatry', status: 'ACTIVE' }
    }
  ];

  assert.deepEqual(mapFacilityProviders(facilityA).map(p => p.id), ['p1', 'p2']);
  assert.deepEqual(mapFacilityProviders(facilityB).map(p => p.id), ['p3']);
  assert.deepEqual(mapFacilityProviders([]), []);
});

test('allows the same provider to appear under each assigned facility', () => {
  const shared = {
    providerId: 'pShared',
    provider: { id: 'pShared', firstName: 'Shared', lastName: 'MD', primarySpecialty: 'Cardiology', status: 'ACTIVE' }
  };
  const underA = mapFacilityProviders([{ ...shared, facilityId: 'fA' }]);
  const underB = mapFacilityProviders([{ ...shared, facilityId: 'fB' }]);
  assert.equal(underA[0].id, 'pShared');
  assert.equal(underB[0].id, 'pShared');
  assert.equal(underA[0].primarySpecialty, 'Cardiology');
});
