import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateConditions,
  validateConditionSchema
} from './requirementConditions';

test('rejects executable condition content', () => {
  assert.throws(() => validateConditionSchema('function(){return true}'), /Executable|JSON|not allowed/i);
  assert.throws(() => validateConditionSchema({ all: [{ field: 'enrollmentType', op: 'eq', value: 'X' }], evil: 1 }), /Unknown/);
  assert.throws(() => validateConditionSchema({ all: [{ field: 'hacked', op: 'eq', value: 1 }] }), /Unsupported/);
});

test('validates and evaluates restricted conditions deterministically', () => {
  const schema = validateConditionSchema({
    all: [
      { field: 'enrollmentType', op: 'eq', value: 'INDIVIDUAL' },
      { field: 'state', op: 'in', value: ['TX', 'CA'] }
    ]
  });
  assert.ok(schema);

  const pass = evaluateConditions(schema, {
    enrollmentType: 'INDIVIDUAL',
    state: 'TX',
    hasFacility: true
  });
  assert.equal(pass.applies, true);

  const failMissingState = evaluateConditions(schema, {
    enrollmentType: 'INDIVIDUAL',
    state: null
  });
  assert.equal(failMissingState.applies, false);
  assert.match(failMissingState.reasons.join(' '), /missing/i);

  const failType = evaluateConditions(schema, {
    enrollmentType: 'GROUP',
    state: 'TX'
  });
  assert.equal(failType.applies, false);
});
