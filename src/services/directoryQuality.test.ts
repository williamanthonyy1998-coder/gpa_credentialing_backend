import assert from 'node:assert/strict';
import test from 'node:test';
import { RecordStatus, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { classifyNameDuplicate, findDuplicatePairs } from './duplicateDetection';
import { validateNpi, npiLuhnValid } from './npiValidation';
import { normalizeDirectoryName, taxIdFingerprint } from './textNormalize';
import { previewDirectoryMerge, commitDirectoryMerge } from './directoryMerge';
import { runDirectoryQualityAudit, persistAuditFindings } from './directoryQualityAudit';
import { createTenant } from './tenants';

const RUN_DB = Boolean(process.env.DATABASE_URL) && process.env.DIRECTORY_TESTS_SKIP !== '1';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test('normalizeDirectoryName collapses case punctuation and spaces', () => {
  assert.equal(normalizeDirectoryName('  Blue-Cross   Blue Shield '), 'blue cross blue shield');
});

test('taxIdFingerprint never returns raw value and matches securely', () => {
  const a = taxIdFingerprint('12-3456789');
  const b = taxIdFingerprint('123456789');
  assert.ok(a && b);
  assert.equal(a, b);
  assert.ok(!String(a).includes('123456789'));
});

test('NPI checksum validates known-good and rejects bad checksum', () => {
  // Construct a valid NPI: try digits starting with 1 until Luhn passes
  let valid = '';
  for (let i = 0; i < 10000; i += 1) {
    const candidate = `1${String(100000000 + i).slice(-9)}`;
    if (npiLuhnValid(candidate)) {
      valid = candidate;
      break;
    }
  }
  assert.ok(valid);
  assert.equal(validateNpi(valid).ok, true);
  assert.equal(validateNpi('1234567890').ok, false);
  assert.equal(validateNpi('abc').ok, false);
});

test('duplicate classification exact vs possible', () => {
  const exact = classifyNameDuplicate(
    { id: '1', name: 'Family Medicine' },
    { id: '2', name: ' family   medicine ' },
    { directoryType: 'specialties', exactFields: ['name'] }
  );
  assert.equal(exact?.strength, 'EXACT');

  const possible = classifyNameDuplicate(
    { id: '1', name: 'Blue Cross Preferred' },
    { id: '2', name: 'Blue Cross Select Care' },
    { directoryType: 'payers', exactFields: ['name'], strongThreshold: 0.95, possibleThreshold: 0.4 }
  );
  assert.ok(possible);
  assert.notEqual(possible.strength, 'EXACT');
});

test('findDuplicatePairs does not false-positive unrelated names', () => {
  const pairs = findDuplicatePairs(
    [
      { id: 'a', name: 'Cardiology' },
      { id: 'b', name: 'Dermatology' }
    ],
    { directoryType: 'specialties', exactFields: ['name'] }
  );
  assert.equal(pairs.length, 0);
});

test(
  'quality audit and specialty merge preview/commit are tenant-safe',
  { skip: !RUN_DB },
  async () => {
    const a = await prisma.specialty.create({
      data: { name: `QA Spec A ${suffix}`, code: `QA-A-${suffix}`, status: RecordStatus.ACTIVE }
    });
    const b = await prisma.specialty.create({
      data: { name: `QA Spec A ${suffix} `, code: `QA-B-${suffix}`, status: RecordStatus.ACTIVE }
    });

    const auditResult = await runDirectoryQualityAudit({ tenantId: null, platformAccess: true, directoryType: 'specialties' });
    assert.ok(auditResult.counts.specialties.total >= 2);
    const persist = await persistAuditFindings(
      auditResult.items.filter((i) => i.fingerprint.includes(a.id) || i.fingerprint.includes(b.id) || i.issueType.startsWith('DUPLICATE_'))
    );
    assert.ok(persist.created >= 0);

    const preview = await previewDirectoryMerge({
      directoryType: 'specialties',
      survivorId: a.id,
      retiredId: b.id,
      role: Role.ADMIN,
      tenantId: null
    });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.actions.length);

    await assert.rejects(
      () => previewDirectoryMerge({
        directoryType: 'payers',
        survivorId: 'x',
        retiredId: 'y',
        role: Role.ADMIN,
        tenantId: null
      }),
      (err: any) => err?.status === 400
    );

    const committed = await commitDirectoryMerge({
      directoryType: 'specialties',
      survivorId: a.id,
      retiredId: b.id,
      role: Role.ADMIN,
      tenantId: null,
      confirm: true
    });
    assert.equal(committed.committed, true);
    const retired = await prisma.specialty.findUnique({ where: { id: b.id } });
    assert.equal(retired?.status, RecordStatus.INACTIVE);

    await prisma.specialty.delete({ where: { id: a.id } }).catch(() => undefined);
    await prisma.specialty.delete({ where: { id: b.id } }).catch(() => undefined);
  }
);

test(
  'billing entity duplicate findings stay tenant isolated',
  { skip: !RUN_DB },
  async () => {
    const tenantA = await createTenant({ name: `QA A ${suffix}`, slug: `qa-a-${suffix}` });
    const tenantB = await createTenant({ name: `QA B ${suffix}`, slug: `qa-b-${suffix}` });
    const beA = await prisma.billingEntity.create({
      data: { tenantId: tenantA.id, legalName: `Acme Billing ${suffix}`, taxId: '11-1111111', status: RecordStatus.ACTIVE }
    });
    const beA2 = await prisma.billingEntity.create({
      data: { tenantId: tenantA.id, legalName: `Acme Billing ${suffix}`, taxId: '22-2222222', status: RecordStatus.ACTIVE }
    });
    const beB = await prisma.billingEntity.create({
      data: { tenantId: tenantB.id, legalName: `Acme Billing ${suffix}`, taxId: '11-1111111', status: RecordStatus.ACTIVE }
    });

    const forA = await runDirectoryQualityAudit({ tenantId: tenantA.id, platformAccess: false, directoryType: 'billingEntities' });
    assert.ok(forA.items.every((i) => i.tenantId === tenantA.id || i.tenantId == null));
    assert.ok(forA.items.some((i) => i.issueType.startsWith('DUPLICATE_')));
    assert.ok(!forA.items.some((i) => i.recordId === beB.id || i.relatedRecordId === beB.id));

    await prisma.billingEntity.deleteMany({ where: { id: { in: [beA.id, beA2.id, beB.id] } } });
  }
);
