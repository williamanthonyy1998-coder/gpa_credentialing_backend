/**
 * Phase 4B — Restricted condition evaluator for payer requirements.
 * No arbitrary JS/SQL/dynamic code. Deterministic, validated schema only.
 */

export type ConditionOp = 'eq' | 'ne' | 'in' | 'not_in' | 'exists';

export type ConditionField =
  | 'enrollmentType'
  | 'specialty'
  | 'state'
  | 'hasFacility'
  | 'hasBillingEntity'
  | 'payerPlanId'
  | 'providerType';

export type ConditionAtom = {
  field: ConditionField;
  op: ConditionOp;
  value?: unknown;
};

export type ConditionGroup = {
  all?: ConditionAtom[];
  any?: ConditionAtom[];
};

export type EvaluationContext = {
  enrollmentType?: string | null;
  specialty?: string | null;
  state?: string | null;
  hasFacility?: boolean;
  hasBillingEntity?: boolean;
  payerPlanId?: string | null;
  providerType?: string | null;
};

const ALLOWED_FIELDS = new Set<ConditionField>([
  'enrollmentType',
  'specialty',
  'state',
  'hasFacility',
  'hasBillingEntity',
  'payerPlanId',
  'providerType'
]);

const ALLOWED_OPS = new Set<ConditionOp>(['eq', 'ne', 'in', 'not_in', 'exists']);

function deny(message: string): never {
  const err: any = new Error(message);
  err.status = 400;
  err.code = 'INVALID_CONDITION';
  throw err;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Reject executable payloads and unknown keys. */
export function validateConditionSchema(raw: unknown): ConditionGroup | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    // Never accept stringified executable code
    if (/function|=>|eval\(|new Function|require\(|import\s/.test(raw)) {
      deny('Executable condition content is not allowed');
    }
    try {
      raw = JSON.parse(raw);
    } catch {
      deny('Conditions must be valid JSON');
    }
  }
  if (!isPlainObject(raw)) deny('Conditions must be an object with all/any arrays');
  const keys = Object.keys(raw);
  for (const k of keys) {
    if (k !== 'all' && k !== 'any') deny(`Unknown condition key: ${k}`);
  }
  const out: ConditionGroup = {};
  if (raw.all !== undefined) {
    if (!Array.isArray(raw.all)) deny('conditions.all must be an array');
    out.all = raw.all.map(validateAtom);
  }
  if (raw.any !== undefined) {
    if (!Array.isArray(raw.any)) deny('conditions.any must be an array');
    out.any = raw.any.map(validateAtom);
  }
  if (!out.all?.length && !out.any?.length) {
    deny('conditions must include at least one all or any atom');
  }
  return out;
}

function validateAtom(raw: unknown): ConditionAtom {
  if (!isPlainObject(raw)) deny('Each condition atom must be an object');
  for (const k of Object.keys(raw)) {
    if (!['field', 'op', 'value'].includes(k)) deny(`Unknown atom key: ${k}`);
  }
  const field = raw.field as ConditionField;
  const op = raw.op as ConditionOp;
  if (!ALLOWED_FIELDS.has(field)) deny(`Unsupported condition field: ${String(raw.field)}`);
  if (!ALLOWED_OPS.has(op)) deny(`Unsupported condition op: ${String(raw.op)}`);
  if (op !== 'exists' && raw.value === undefined) deny(`Condition value required for op ${op}`);
  if ((op === 'in' || op === 'not_in') && !Array.isArray(raw.value)) {
    deny(`Condition op ${op} requires an array value`);
  }
  return { field, op, value: raw.value };
}

function readField(ctx: EvaluationContext, field: ConditionField): unknown {
  switch (field) {
    case 'enrollmentType': return ctx.enrollmentType ?? null;
    case 'specialty': return ctx.specialty ?? null;
    case 'state': return ctx.state ?? null;
    case 'hasFacility': return Boolean(ctx.hasFacility);
    case 'hasBillingEntity': return Boolean(ctx.hasBillingEntity);
    case 'payerPlanId': return ctx.payerPlanId ?? null;
    case 'providerType': return ctx.providerType ?? null;
    default: return null;
  }
}

function evalAtom(atom: ConditionAtom, ctx: EvaluationContext): { pass: boolean; reason: string } {
  const actual = readField(ctx, atom.field);
  if (atom.op === 'exists') {
    const pass = actual !== null && actual !== undefined && actual !== '';
    return { pass, reason: `${atom.field} exists=${pass}` };
  }
  // Missing context for mandatory matching fields → do not silently pass
  if (actual === null || actual === undefined || actual === '') {
    if (atom.field === 'hasFacility' || atom.field === 'hasBillingEntity') {
      // boolean fields always have a value via Boolean()
    } else {
      return { pass: false, reason: `${atom.field} missing in enrollment context` };
    }
  }
  if (atom.op === 'eq') {
    const pass = String(actual) === String(atom.value) || actual === atom.value;
    return { pass, reason: `${atom.field} ${pass ? '==' : '!='} ${String(atom.value)}` };
  }
  if (atom.op === 'ne') {
    const pass = String(actual) !== String(atom.value) && actual !== atom.value;
    return { pass, reason: `${atom.field} ${pass ? '!=' : '=='} ${String(atom.value)}` };
  }
  if (atom.op === 'in') {
    const list = (atom.value as unknown[]).map(String);
    const pass = list.includes(String(actual));
    return { pass, reason: `${atom.field} in [${list.join(',')}] → ${pass}` };
  }
  if (atom.op === 'not_in') {
    const list = (atom.value as unknown[]).map(String);
    const pass = !list.includes(String(actual));
    return { pass, reason: `${atom.field} not_in [${list.join(',')}] → ${pass}` };
  }
  return { pass: false, reason: 'unknown op' };
}

export function evaluateConditions(
  raw: unknown,
  ctx: EvaluationContext
): { applies: boolean; reasons: string[]; invalid?: boolean } {
  if (raw == null || raw === '') {
    return { applies: true, reasons: ['No conditions — applies by default'] };
  }
  let group: ConditionGroup;
  try {
    group = validateConditionSchema(raw)!;
  } catch (e: any) {
    return { applies: false, reasons: [e.message || 'Invalid conditions'], invalid: true };
  }
  const reasons: string[] = [];
  if (group.all?.length) {
    for (const atom of group.all) {
      const r = evalAtom(atom, ctx);
      reasons.push(`ALL: ${r.reason}`);
      if (!r.pass) return { applies: false, reasons };
    }
  }
  if (group.any?.length) {
    let anyPass = false;
    for (const atom of group.any) {
      const r = evalAtom(atom, ctx);
      reasons.push(`ANY: ${r.reason}`);
      if (r.pass) anyPass = true;
    }
    if (!anyPass) return { applies: false, reasons };
  }
  return { applies: true, reasons };
}
