import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  assertCredentialCategoryCodeAssignable,
  assertPayerPlanAssignable,
  normalizeLicenseFields,
  normalizeProviderSpecialtyFields,
  resolveUsStateByAbbrev
} from './directoryIntegration';
import { createTenant } from './tenants';

const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.DIRECTORY_TESTS_SKIP !== '1';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('normalizeProviderSpecialtyFields rejects duplicate primary/secondary', async () => {
  await assert.rejects(
    () => normalizeProviderSpecialtyFields({
      primarySpecialtyId: 'same-id',
      secondarySpecialtyId: 'same-id'
    }, { forCreate: true }),
    (err: any) => /different/i.test(String(err?.message || ''))
  );
});

test(
  'specialty and license directory integration round-trip',
  { skip: !RUN_DB },
  async () => {
    // Self-contained fixtures when directory seed is absent.
    const specialty = await prisma.specialty.create({
      data: { name: `Int Spec A ${suffix}`, code: `ISA-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const secondary = await prisma.specialty.create({
      data: { name: `Int Spec B ${suffix}`, code: `ISB-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const licenseType = await prisma.licenseType.create({
      data: { code: `LT-${suffix}`, name: `License Type ${suffix}`, status: RecordStatus.ACTIVE }
    });
    let state = await prisma.usState.findFirst({
      where: { abbreviation: 'TX' },
      select: { id: true, abbreviation: true }
    });
    if (!state) {
      state = await prisma.usState.create({
        data: { name: 'Texas', abbreviation: 'TX', status: RecordStatus.ACTIVE },
        select: { id: true, abbreviation: true }
      });
    }

    const fields = await normalizeProviderSpecialtyFields({
      primarySpecialtyId: specialty.id,
      secondarySpecialtyId: secondary.id
    }, { forCreate: true });
    assert.equal(fields.primarySpecialtyId, specialty.id);
    assert.equal(fields.primarySpecialty, specialty.name);
    assert.equal(fields.secondarySpecialtyId, secondary.id);

    const lic = await normalizeLicenseFields({
      licenseTypeId: licenseType.id,
      usStateId: state.id
    }, { forCreate: true });
    assert.equal(lic.licenseTypeId, licenseType.id);
    assert.equal(lic.type, licenseType.name);
    assert.equal(lic.usStateId, state.id);
    assert.equal(lic.state, 'TX');

    const byAbbrev = await resolveUsStateByAbbrev('tx');
    assert.equal(byAbbrev?.abbreviation, 'TX');

    await prisma.specialty.delete({ where: { id: specialty.id } });
    await prisma.specialty.delete({ where: { id: secondary.id } });
    await prisma.licenseType.delete({ where: { id: licenseType.id } });
  }
);

test(
  'inactive specialty rejected on create but TX abbrev maps',
  { skip: !RUN_DB },
  async () => {
    const inactive = await prisma.specialty.create({
      data: {
        name: `Inactive Spec ${suffix}`,
        code: `INACT-${suffix}`,
        status: RecordStatus.INACTIVE
      }
    });
    await assert.rejects(
      () => normalizeProviderSpecialtyFields({ primarySpecialtyId: inactive.id }, { forCreate: true }),
      (err: any) => /inactive/i.test(String(err?.message || ''))
    );
    const allowed = await normalizeProviderSpecialtyFields(
      { primarySpecialtyId: inactive.id },
      { forCreate: false }
    );
    assert.equal(allowed.primarySpecialtyId, inactive.id);
    await prisma.specialty.delete({ where: { id: inactive.id } });
  }
);

test(
  'payer plan assignable requires active payer+plan',
  { skip: !RUN_DB },
  async () => {
    const payer = await prisma.payer.create({
      data: { name: `Plan Payer ${suffix}`, payerCode: `PP-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const plan = await prisma.payerPlan.create({
      data: { payerId: payer.id, name: `Active Plan ${suffix}`, status: RecordStatus.ACTIVE }
    });
    const inactivePlan = await prisma.payerPlan.create({
      data: { payerId: payer.id, name: `Inactive Plan ${suffix}`, status: RecordStatus.INACTIVE }
    });

    const ok = await assertPayerPlanAssignable(plan.id, { requireActive: true });
    assert.equal(ok.id, plan.id);

    await assert.rejects(
      () => assertPayerPlanAssignable(inactivePlan.id, { requireActive: true }),
      (err: any) => /inactive/i.test(String(err?.message || ''))
    );

    await prisma.payerPlan.delete({ where: { id: plan.id } });
    await prisma.payerPlan.delete({ where: { id: inactivePlan.id } });
    await prisma.payer.delete({ where: { id: payer.id } });
  }
);

test(
  'tenant credential category isolation on assign',
  { skip: !RUN_DB },
  async () => {
    const tenantA = await createTenant({ name: `Int A ${suffix}`, slug: `int-a-${suffix}` });
    const tenantB = await createTenant({ name: `Int B ${suffix}`, slug: `int-b-${suffix}` });
    const catB = await prisma.credentialCategory.create({
      data: {
        scope: 'TENANT',
        tenantId: tenantB.id,
        code: `tb-cat-${suffix}`,
        name: `Tenant B Cat ${suffix}`,
        status: RecordStatus.ACTIVE
      }
    });
    await assert.rejects(
      () => assertCredentialCategoryCodeAssignable(catB.code, tenantA.id, { forCreate: true }),
      () => true
    );
    const ok = await assertCredentialCategoryCodeAssignable(catB.code, tenantB.id, { forCreate: true });
    assert.equal(ok?.id, catB.id);

    await prisma.credentialCategory.delete({ where: { id: catB.id } }).catch(() => undefined);
  }
);
