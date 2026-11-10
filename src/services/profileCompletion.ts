type FieldSpec = { key: string; label: string; required?: boolean; path?: string };

const ORG_FIELDS: FieldSpec[] = [
  { key: 'legalName', label: 'Legal name', required: true },
  { key: 'taxId', label: 'Tax ID', required: true },
  { key: 'contactName', label: 'Contact name', required: true },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'mailingAddress', label: 'Mailing address', required: true },
  { key: 'establishedAt', label: 'Established date' },
  { key: 'dba', label: 'DBA' }
];

const PRACTICE_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Practice name', required: true },
  { key: 'organizationId', label: 'Organization', required: true },
  { key: 'npi', label: 'NPI', required: true },
  { key: 'taxId', label: 'Tax ID', required: true },
  { key: 'taxonomyCode', label: 'Taxonomy', required: true },
  { key: 'contactName', label: 'Contact name', required: true },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'mailingAddress', label: 'Mailing address', required: true },
  { key: 'primaryAddress', label: 'Primary address' },
  { key: 'bankName', label: 'Bank name' },
  { key: 'owners', label: 'Owners' }
];

const FACILITY_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Facility name', required: true },
  { key: 'npi', label: 'NPI', required: true },
  { key: 'contactName', label: 'Contact name', required: true },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'address', label: 'Address', required: true },
  { key: 'schedule', label: 'Weekly schedule', required: true },
  { key: 'organizationId', label: 'Organization' },
  { key: 'practiceId', label: 'Practice' }
];

const PROVIDER_FIELDS: FieldSpec[] = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: true },
  { key: 'npi', label: 'NPI', required: true },
  { key: 'dateOfBirth', label: 'Date of birth', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'primarySpecialty', label: 'Primary specialty', required: true },
  { key: 'taxonomyCode', label: 'Taxonomy', required: true },
  { key: 'professionalType', label: 'Professional type', required: true },
  { key: 'homePhone', label: 'Phone' },
  { key: 'address', label: 'Address' },
  { key: 'licenses', label: 'Licenses' }
];

function present(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function score(record: any, fields: FieldSpec[]) {
  const required = fields.filter(f => f.required);
  const scored = required.length ? required : fields;
  const missing = scored.filter(f => !present(record?.[f.key])).map(f => f.label);
  const filled = scored.length - missing.length;
  const percent = scored.length ? Math.round((filled / scored.length) * 100) : 100;
  return { percent, filled, total: scored.length, missing, fields: scored.map(f => ({ ...f, complete: present(record?.[f.key]) })) };
}

export function profileCompletion(entity: 'organization' | 'practice' | 'facility' | 'provider', record: any) {
  switch (entity) {
    case 'organization': return score(record, ORG_FIELDS);
    case 'practice': return score(record, PRACTICE_FIELDS);
    case 'facility': return score(record, FACILITY_FIELDS);
    case 'provider': return score(record, PROVIDER_FIELDS);
    default: return { percent: 0, filled: 0, total: 0, missing: [], fields: [] };
  }
}
