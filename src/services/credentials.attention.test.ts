import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_CATEGORIES,
  computeCredentialAttention,
  isAgreementsCategory,
  isOtherDocumentsCategory
} from './credentials';
import { extractInsuranceFieldsFromText } from './insuranceExtract';
import { AGREEMENTS_ALLOWED_MIME, OTHER_DOCUMENTS_ALLOWED_MIME } from './fileMagic';

test('Other Documents category is listed directly below Portals', () => {
  const keys = DOCUMENT_CATEGORIES.map(c => c.key);
  const portalsIdx = keys.indexOf('portals');
  const otherIdx = keys.indexOf('other');
  assert.ok(portalsIdx >= 0, 'portals category missing');
  assert.ok(otherIdx >= 0, 'other category missing');
  assert.equal(otherIdx, portalsIdx + 1);
  assert.equal(DOCUMENT_CATEGORIES[otherIdx].label, 'Other Documents');
  assert.deepEqual(DOCUMENT_CATEGORIES[otherIdx].types, []);
  assert.equal(isOtherDocumentsCategory('other'), true);
  assert.equal(isOtherDocumentsCategory('portals'), false);
});

test('Other Documents allow only PDF/JPG/PNG MIME types', () => {
  assert.equal(OTHER_DOCUMENTS_ALLOWED_MIME.has('application/pdf'), true);
  assert.equal(OTHER_DOCUMENTS_ALLOWED_MIME.has('image/jpeg'), true);
  assert.equal(OTHER_DOCUMENTS_ALLOWED_MIME.has('image/png'), true);
  assert.equal(OTHER_DOCUMENTS_ALLOWED_MIME.has('application/msword'), false);
});

test('Agreements & Contracts category and MIME allowlist', () => {
  const agreements = DOCUMENT_CATEGORIES.find(c => c.key === 'agreements');
  assert.ok(agreements, 'agreements category missing');
  assert.equal(agreements.label, 'Agreements & Contracts');
  assert.ok(agreements.types.some(t => t.type === 'Participation Agreement'));
  assert.ok(agreements.types.some(t => t.type === 'Business Associate Agreement'));
  assert.equal(isAgreementsCategory('agreements'), true);
  assert.equal(isAgreementsCategory('other'), false);
  assert.equal(AGREEMENTS_ALLOWED_MIME.has('application/pdf'), true);
  assert.equal(AGREEMENTS_ALLOWED_MIME.has('image/jpeg'), true);
  assert.equal(AGREEMENTS_ALLOWED_MIME.has('image/png'), true);
  assert.equal(AGREEMENTS_ALLOWED_MIME.has('application/msword'), false);
});

test('ignored credentials return IGNORED and are not missing/expired', () => {
  const attention = computeCredentialAttention({
    ignored: true,
    required: true,
    storageKey: null,
    expiresAt: '2000-01-01',
    warningDays: 30
  });
  assert.equal(attention, 'IGNORED');
});

test('missing when no file', () => {
  assert.equal(computeCredentialAttention({ required: true, storageKey: null, status: 'MISSING' }), 'MISSING');
});

test('available when file present and outside warning window', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const attention = computeCredentialAttention({
    storageKey: 'file.pdf',
    expiresAt: '2026-06-01',
    warningDays: 30
  }, now);
  assert.equal(attention, 'AVAILABLE');
});

test('expiring soon uses selected warning days (30)', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const attention = computeCredentialAttention({
    storageKey: 'file.pdf',
    expiresAt: '2026-01-20',
    warningDays: 30
  }, now);
  assert.equal(attention, 'EXPIRING_SOON');
});

test('expiring soon uses selected warning days (90) boundary', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const soon = computeCredentialAttention({
    storageKey: 'file.pdf',
    expiresAt: '2026-03-30',
    warningDays: 90
  }, now);
  const available = computeCredentialAttention({
    storageKey: 'file.pdf',
    expiresAt: '2026-03-30',
    warningDays: 30
  }, now);
  assert.equal(soon, 'EXPIRING_SOON');
  assert.equal(available, 'AVAILABLE');
});

test('expired when past expiration', () => {
  const now = new Date('2026-02-01T12:00:00Z');
  assert.equal(computeCredentialAttention({
    storageKey: 'file.pdf',
    expiresAt: '2026-01-15',
    warningDays: 120
  }, now), 'EXPIRED');
});

test('insurance text extraction finds policy fields without inventing values', () => {
  const text = `
    ACME Insurance Company
    Named Insured: Demo Medical Group LLC
    Policy Number: GL-998877
    Effective Date: 01/15/2026
    Expiration Date: 01/15/2027
    Per Occurrence: $1,000,000
    General Aggregate: $3,000,000
    Commercial General Liability
  `;
  const result = extractInsuranceFieldsFromText(text);
  assert.equal(result.ok, true);
  assert.equal(result.fields.policyNumber.value, 'GL-998877');
  assert.equal(result.fields.perOccurrence.value, 1000000);
  assert.equal(result.fields.aggregate.value, 3000000);
  assert.equal(result.fields.issuedAt.value, '2026-01-15');
  assert.equal(result.fields.expiresAt.value, '2027-01-15');
  assert.equal(result.fields.documentType.value, 'General Liability Insurance');
});

test('empty text does not claim OCR success', () => {
  const result = extractInsuranceFieldsFromText('   ');
  assert.equal(result.ok, false);
  assert.equal(result.fields.policyNumber.value, null);
});
