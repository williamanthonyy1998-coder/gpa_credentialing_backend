import assert from 'node:assert/strict';
import test from 'node:test';
import { Role } from '@prisma/client';
import {
  sanitizeDocumentForAudience,
  stripClientWritableFileFields
} from './documentAudience';

test('RT-02: clients never receive notes or storageKey', () => {
  const row = {
    id: 'd1',
    title: 'W-9',
    notes: 'internal review note',
    storageKey: 'abc.pdf',
    securityStatus: 'AVAILABLE'
  };
  const client = sanitizeDocumentForAudience(row, Role.CLIENT_USER) as any;
  assert.equal(client.notes, undefined);
  assert.equal(client.storageKey, undefined);
  assert.equal(client.hasFile, true);
  assert.equal(client.title, 'W-9');

  const provider = sanitizeDocumentForAudience(row, Role.EXTERNAL_PROVIDER) as any;
  assert.equal(provider.notes, undefined);
  assert.equal(provider.storageKey, undefined);
});

test('RT-02: GPA staff keep notes and storageKey for UI; hasFile set', () => {
  const row = { id: 'd1', notes: 'staff note', storageKey: 'abc.pdf' };
  const staff = sanitizeDocumentForAudience(row, Role.CREDENTIALING_MANAGER) as any;
  assert.equal(staff.notes, 'staff note');
  assert.equal(staff.storageKey, 'abc.pdf');
  assert.equal(staff.hasFile, true);
});

test('RT-01: stripClientWritableFileFields removes storage fields', () => {
  const cleaned = stripClientWritableFileFields({
    title: 'x',
    storageKey: 'evil.pdf',
    originalName: 'x.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 12,
    securityStatus: 'AVAILABLE'
  }) as any;
  assert.equal(cleaned.title, 'x');
  assert.equal(cleaned.storageKey, undefined);
  assert.equal(cleaned.securityStatus, undefined);
  assert.equal(cleaned.originalName, undefined);
});
