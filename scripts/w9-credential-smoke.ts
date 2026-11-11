/**
 * W-9 / IRS Documents attachment workflow smoke tests (API + DB).
 * Requires API on SMOKE_API_URL (default http://localhost:4000).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const base = process.env.SMOKE_API_URL || 'http://localhost:4000';
const email = process.env.SMOKE_EMAIL || 'admin@example.com';
const password = process.env.SEED_DEFAULT_PASSWORD || 'LocalDemo-ChangeThis-2026!';
const prisma = new PrismaClient();

type Result = { name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; detail?: string };

async function req(pathName: string, opts: RequestInit = {}, token?: string) {
  const headers: any = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathName}`, { ...opts, headers });
  const contentType = res.headers.get('content-type') || '';
  let body: any = null;
  if (contentType.includes('application/json')) body = await res.json();
  else if (opts.method === 'DELETE' && res.status === 204) body = null;
  else body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers };
}

function pdfFixture() {
  const text = `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 74 >>stream
BT /F1 12 Tf 50 750 Td (W-9 Form Smoke Document) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000394 00000 n 
trailer<< /Size 6 /Root 1 0 R >>
startxref
463
%%EOF`;
  return Buffer.from(text);
}

function jpegFixture() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c,
    0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
    0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01,
    0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9
  ]);
}

async function main() {
  const results: Result[] = [];
  const createdIds: string[] = [];

  const health = await req('/health');
  if (health.status !== 200) {
    console.error('API not reachable', health.status);
    process.exit(1);
  }

  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  if (login.status !== 200 || !login.body?.token) {
    console.error('Login failed', login.body);
    process.exit(1);
  }
  const token = login.body.token as string;

  const cats = await req('/api/credentials/categories', {}, token);
  try {
    if (cats.status !== 200) throw new Error(`categories ${cats.status}`);
    const irs = (cats.body || []).find((c: any) => c.key === 'irs');
    if (!irs) throw new Error('irs category missing');
    if (irs.label !== 'IRS Documents') throw new Error('Wrong IRS label');
    const types = (irs.types || []).map((t: any) => t.type);
    if (!types.includes('W-9 Form') || !types.includes('IRS CP-575 / EIN Letter')) {
      throw new Error(`missing IRS types: ${types.join(',')}`);
    }
    results.push({ name: 'Test 1 categories include IRS Documents / W-9 Form', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 1 categories include IRS Documents / W-9 Form', status: 'FAIL', detail: e.message });
  }

  const facilitiesRes = await req('/api/facilities?limit=5', {}, token);
  if (facilitiesRes.status !== 200 || !facilitiesRes.body?.length) {
    console.error('No facilities available for smoke test');
    process.exit(1);
  }
  const facility = facilitiesRes.body[0];
  const otherFacility = facilitiesRes.body[1] || null;
  const orgId = facility.organizationId || facility.organization?.id || null;

  // Create W-9 + PDF upload + authenticated inline preview
  try {
    const create = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'W-9 Form Smoke',
        type: 'W-9 Form',
        category: 'irs',
        facilityId: facility.id,
        organizationId: orgId || undefined,
        practiceId: facility.practiceId || undefined,
        warningDays: 90,
        issuedAt: '2026-01-15T12:00:00.000Z',
        expiresAt: '2027-01-15T12:00:00.000Z',
        notes: 'W-9 smoke test',
        required: true,
        reportingRequired: true,
        ignored: false
      })
    }, token);
    if (create.status !== 201) throw new Error(`create ${create.status} ${JSON.stringify(create.body)}`);
    createdIds.push(create.body.id);
    if (create.body.category !== 'irs') throw new Error(`unexpected category ${create.body.category}`);
    if (create.body.facilityId !== facility.id) throw new Error('facility association missing');
    if (create.body.attention !== 'MISSING') throw new Error(`expected MISSING before upload, got ${create.body.attention}`);

    const fd = new FormData();
    fd.append('file', new Blob([pdfFixture()], { type: 'application/pdf' }), 'w9-form.pdf');
    const up = await req(`/api/documents/${create.body.id}/file`, { method: 'POST', body: fd }, token);
    if (up.status !== 200) throw new Error(`upload ${up.status} ${JSON.stringify(up.body)}`);

    const view = await req(`/api/credentials/${create.body.id}`, {}, token);
    if (view.status !== 200) throw new Error(`view ${view.status}`);
    if (!view.body.storageKey) throw new Error('storageKey missing after upload');
    if (view.body.originalName !== 'w9-form.pdf') throw new Error('originalName not persisted');
    if (view.body.facilityId !== facility.id) throw new Error('facilityId lost after upload');

    const preview = await req(`/api/documents/${create.body.id}/file?inline=1`, {}, token);
    if (preview.status !== 200) throw new Error(`inline preview ${preview.status}`);
    const disposition = preview.headers.get('content-disposition') || '';
    if (!/inline/i.test(disposition)) throw new Error('preview disposition is not inline');
    if (String(preview.headers.get('cache-control') || '').includes('public')) {
      throw new Error('preview cache-control must remain private');
    }

    results.push({ name: 'Test 2 create + PDF upload + private inline preview', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 2 create + PDF upload + private inline preview', status: 'FAIL', detail: e.message });
  }

  const primaryId = createdIds[0];

  // Replace with JPG
  if (primaryId) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([jpegFixture()], { type: 'image/jpeg' }), 'w9-scan.jpg');
      const replace = await req(`/api/documents/${primaryId}/file?replace=true`, { method: 'POST', body: fd }, token);
      if (replace.status !== 200) throw new Error(`replace ${replace.status} ${JSON.stringify(replace.body)}`);
      const db = await prisma.document.findUnique({ where: { id: primaryId } });
      if (!db?.storageKey || db.mimeType !== 'image/jpeg') throw new Error('JPG replace metadata missing');
      if (db.facilityId !== facility.id) throw new Error('facility association lost on replace');
      results.push({ name: 'Test 3 replace PDF with JPG', status: 'PASS' });
    } catch (e: any) {
      results.push({ name: 'Test 3 replace PDF with JPG', status: 'FAIL', detail: e.message });
    }
  } else {
    results.push({ name: 'Test 3 replace PDF with JPG', status: 'BLOCKED', detail: 'No primary credential' });
  }

  // Download attachment
  if (primaryId) {
    try {
      const dl = await req(`/api/documents/${primaryId}/file`, {}, token);
      if (dl.status !== 200) throw new Error(`download ${dl.status}`);
      if (!Buffer.isBuffer(dl.body) || dl.body.length < 10) throw new Error('download body empty');
      results.push({ name: 'Test 4 download attachment', status: 'PASS' });
    } catch (e: any) {
      results.push({ name: 'Test 4 download attachment', status: 'FAIL', detail: e.message });
    }
  } else {
    results.push({ name: 'Test 4 download attachment', status: 'BLOCKED', detail: 'No primary credential' });
  }

  // Persistence after edit + category list refresh
  if (primaryId) {
    try {
      const patch = await req(`/api/credentials/${primaryId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: 'W-9 Form Smoke Updated',
          type: 'W-9 Form',
          category: 'irs',
          warningDays: 120,
          notes: 'Updated W-9 notes',
          required: true
        })
      }, token);
      if (patch.status !== 200) throw new Error(`patch ${patch.status} ${JSON.stringify(patch.body)}`);

      const list = await req(`/api/credentials?facilityId=${facility.id}&category=irs&limit=100`, {}, token);
      if (list.status !== 200) throw new Error(`list ${list.status}`);
      const found = (list.body || []).find((r: any) => r.id === primaryId);
      if (!found) throw new Error('credential missing from category=irs list after refresh');
      if (found.title !== 'W-9 Form Smoke Updated') throw new Error('title not persisted');
      if (!found.storageKey) throw new Error('attachment missing after metadata edit');
      if (found.warningDays !== 120) throw new Error('warningDays not persisted');

      results.push({ name: 'Test 5 edit + list persistence + attachment retained', status: 'PASS' });
    } catch (e: any) {
      results.push({ name: 'Test 5 edit + list persistence + attachment retained', status: 'FAIL', detail: e.message });
    }
  } else {
    results.push({ name: 'Test 5 edit + list persistence + attachment retained', status: 'BLOCKED', detail: 'No primary credential' });
  }

  // Reject DOC upload for IRS / W-9
  if (primaryId) {
    try {
      const fd = new FormData();
      fd.append(
        'file',
        new Blob([Buffer.from('PK\u0003\u0004fake')], { type: 'application/msword' }),
        'bad.doc'
      );
      const bad = await req(`/api/documents/${primaryId}/file?replace=true`, { method: 'POST', body: fd }, token);
      if (bad.status === 200) throw new Error('DOC upload should be rejected for IRS / W-9');
      results.push({ name: 'Test 6 reject non-PDF/image for W-9', status: 'PASS' });
    } catch (e: any) {
      results.push({ name: 'Test 6 reject non-PDF/image for W-9', status: 'FAIL', detail: e.message });
    }
  } else {
    results.push({ name: 'Test 6 reject non-PDF/image for W-9', status: 'BLOCKED', detail: 'No primary credential' });
  }

  // Multiple W-9 documents on same facility
  try {
    const create2 = await req('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        title: 'W-9 Prior Year Smoke',
        type: 'W-9 Form',
        category: 'irs',
        facilityId: facility.id,
        organizationId: orgId || undefined,
        practiceId: facility.practiceId || undefined,
        warningDays: 30,
        required: true,
        reportingRequired: true,
        ignored: false
      })
    }, token);
    if (create2.status !== 201) throw new Error(`create2 ${create2.status} ${JSON.stringify(create2.body)}`);
    createdIds.push(create2.body.id);

    const fd = new FormData();
    fd.append('file', new Blob([pdfFixture()], { type: 'application/pdf' }), 'w9-prior.pdf');
    const up2 = await req(`/api/documents/${create2.body.id}/file`, { method: 'POST', body: fd }, token);
    if (up2.status !== 200) throw new Error(`upload2 ${up2.status} ${JSON.stringify(up2.body)}`);

    const list = await req(`/api/credentials?facilityId=${facility.id}&category=irs&limit=100`, {}, token);
    const mine = (list.body || []).filter((r: any) => createdIds.includes(r.id));
    if (mine.length < 2) throw new Error('expected multiple W-9 credentials for facility');
    if (!mine.every((r: any) => r.storageKey && r.facilityId === facility.id)) {
      throw new Error('each W-9 must keep its own facility-scoped attachment');
    }
    results.push({ name: 'Test 7 multiple W-9 docs each with own attachment', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 7 multiple W-9 docs each with own attachment', status: 'FAIL', detail: e.message });
  }

  // Facility isolation
  if (primaryId && otherFacility) {
    try {
      const otherList = await req(`/api/credentials?facilityId=${otherFacility.id}&category=irs&limit=100`, {}, token);
      if (otherList.status !== 200) throw new Error(`other list ${otherList.status}`);
      const leaked = (otherList.body || []).some((r: any) => createdIds.includes(r.id));
      if (leaked) throw new Error('W-9 credentials leaked across facilities');
      results.push({ name: 'Test 8 facility isolation', status: 'PASS' });
    } catch (e: any) {
      results.push({ name: 'Test 8 facility isolation', status: 'FAIL', detail: e.message });
    }
  } else {
    results.push({
      name: 'Test 8 facility isolation',
      status: otherFacility ? 'BLOCKED' : 'PASS',
      detail: otherFacility ? 'No primary credential' : 'Only one facility available; skipped cross-facility check'
    });
  }

  // Remove file then delete credentials
  if (primaryId) {
    try {
      const rm = await req(`/api/documents/${primaryId}/file`, { method: 'DELETE' }, token);
      if (rm.status !== 200) throw new Error(`remove file ${rm.status} ${JSON.stringify(rm.body)}`);
      const db = await prisma.document.findUnique({ where: { id: primaryId } });
      if (db?.storageKey) throw new Error('storageKey still set after remove');
      results.push({ name: 'Test 9 remove attachment', status: 'PASS' });
    } catch (e: any) {
      results.push({ name: 'Test 9 remove attachment', status: 'FAIL', detail: e.message });
    }
  } else {
    results.push({ name: 'Test 9 remove attachment', status: 'BLOCKED', detail: 'No primary credential' });
  }

  try {
    for (const id of [...createdIds]) {
      const del = await req(`/api/credentials/${id}`, { method: 'DELETE' }, token);
      if (![200, 204].includes(del.status)) throw new Error(`delete ${id} ${del.status} ${JSON.stringify(del.body)}`);
      const gone = await prisma.document.findUnique({ where: { id } });
      if (gone) throw new Error(`document ${id} still present after delete`);
    }
    createdIds.splice(0, createdIds.length);
    results.push({ name: 'Test 10 delete W-9 credentials', status: 'PASS' });
  } catch (e: any) {
    results.push({ name: 'Test 10 delete W-9 credentials', status: 'FAIL', detail: e.message });
  }

  for (const id of createdIds) {
    try { await prisma.document.delete({ where: { id } }); } catch { /* ignore */ }
  }

  console.log('\nW-9 / IRS Documents smoke results:');
  for (const r of results) {
    console.log(`${r.status.padEnd(7)} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = results.filter(r => r.status === 'FAIL').length;
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
