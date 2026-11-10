import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidAbaRoutingNumber,
  isValidBankAccountType,
  isValidBankPhone,
  normalizeRoutingNumber
} from './bankingValidation';
import { extractBankingFieldsFromText } from './bankingExtract';
import { encryptField, decryptField, maskLast4 } from '../lib/fieldCrypto';

test('ABA routing accepts known valid checksum', () => {
  // 021000021 is a well-known valid ABA routing (JPMorgan Chase)
  assert.equal(isValidAbaRoutingNumber('021000021'), true);
  assert.equal(isValidAbaRoutingNumber('021-000-021'), true);
});

test('ABA routing rejects wrong length and bad checksum', () => {
  assert.equal(isValidAbaRoutingNumber('123'), false);
  assert.equal(isValidAbaRoutingNumber('123456789'), false);
  assert.equal(isValidAbaRoutingNumber('abcdefghij'), false);
  assert.equal(isValidAbaRoutingNumber('000000000'), false);
});

test('normalizeRoutingNumber strips non-digits', () => {
  assert.equal(normalizeRoutingNumber('021-000-021'), '021000021');
});

test('bank phone validation', () => {
  assert.equal(isValidBankPhone('555-0181'), true);
  assert.equal(isValidBankPhone('(555) 018-1234'), true);
  assert.equal(isValidBankPhone('+1 555 018 1234'), true);
  assert.equal(isValidBankPhone(''), true);
  assert.equal(isValidBankPhone(null), true);
  assert.equal(isValidBankPhone('abc'), false);
  assert.equal(isValidBankPhone('123'), false);
});

test('account type dropdown values only', () => {
  assert.equal(isValidBankAccountType('Checking'), true);
  assert.equal(isValidBankAccountType('Savings'), true);
  assert.equal(isValidBankAccountType('Other'), true);
  assert.equal(isValidBankAccountType('Money Market'), false);
  assert.equal(isValidBankAccountType(''), true);
});

test('banking PDF text extraction finds labeled fields without inventing', () => {
  const text = `
    Bank Letter
    Bank Name: Demo Community Bank
    Account Title: Lone Star Medical Group LLC
    Routing Number: 021000021
    Account Holder: Lone Star Medical Group LLC
    Issue Date: 03/15/2026
    Phone: 555-0181
  `;
  const result = extractBankingFieldsFromText(text, 'Bank Letter');
  assert.equal(result.ok, true);
  assert.equal(result.fields.bankName.value, 'Demo Community Bank');
  assert.equal(result.fields.bankRoutingNumber.value, '021000021');
  assert.equal(result.fields.bankTitle.value, 'Lone Star Medical Group LLC');
  assert.equal(result.fields.issuedAt.value, '2026-03-15');
  assert.equal(result.fields.documentType.value, 'Bank Letter');
});

test('banking extraction does not invent routing from invalid digits', () => {
  const text = 'Bank Name: Demo Bank\nReference: 123456789';
  const result = extractBankingFieldsFromText(text);
  assert.equal(result.fields.bankRoutingNumber.value, null);
  assert.equal(result.fields.bankName.value, 'Demo Bank');
});

test('field encryption round-trip and masking', () => {
  process.env.FIELD_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const enc = encryptField('021000021');
  assert.ok(enc && enc.startsWith('enc:v1:'));
  assert.equal(decryptField(enc), '021000021');
  assert.equal(maskLast4('021000021'), '••••0021');
});
