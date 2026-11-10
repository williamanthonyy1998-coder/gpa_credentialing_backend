import assert from 'node:assert/strict';
import test from 'node:test';
import { missingIntakeFields } from './intakeConvert';

test('provider intake requires NPI and names', () => {
  const missing = missingIntakeFields('PROVIDER', { firstName: 'A' });
  assert.ok(missing.includes('Provider last name'));
  assert.ok(missing.includes('Provider NPI'));
});

test('combined intake validates practice organization', () => {
  const missing = missingIntakeFields('COMBINED', {
    provider: { firstName: 'A', lastName: 'B', npi: '1' },
    practice: { name: 'Clinic' }
  });
  assert.ok(missing.includes('Organization'));
});
