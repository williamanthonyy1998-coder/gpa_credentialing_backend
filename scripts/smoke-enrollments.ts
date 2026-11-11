/**
 * Enrollment create/list/filter smoke against a running API.
 * Usage: npx tsx scripts/smoke-enrollments.ts
 */
import 'dotenv/config';

const base = process.env.SMOKE_API_URL || 'http://localhost:4000';
const email = process.env.SMOKE_EMAIL || 'admin@example.com';
const password = process.env.SEED_DEFAULT_PASSWORD || 'LocalDemo-ChangeThis-2026!';

async function req(path: string, opts: RequestInit = {}, token?: string) {
  const headers: any = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  assert(login.status === 200 && login.body?.token, `login failed: ${login.status}`);
  const token = login.body.token as string;

  const [payers, plans, practices, facilities, providers] = await Promise.all([
    req('/api/payers?limit=20', {}, token),
    req('/api/plans?limit=50', {}, token),
    req('/api/practices?limit=20', {}, token),
    req('/api/facilities?limit=50', {}, token),
    req('/api/providers?limit=20', {}, token)
  ]);
  assert(payers.status === 200 && payers.body?.length, 'need payers');
  assert(plans.status === 200 && plans.body?.length, 'need plans');
  assert(facilities.status === 200 && facilities.body?.length, 'need facilities');

  const facility = facilities.body.find((f: any) => f.practiceId) || facilities.body[0];
  const practice = practices.body.find((p: any) => p.id === facility.practiceId) || practices.body[0];
  const plan = plans.body[0];
  const payerId = plan.payerId || plan.payer?.id;

  const facilityProviders = await req(`/api/directory/facilities/${facility.id}/providers`, {}, token);
  const linkedProvider = (facilityProviders.body || [])[0]?.provider || providers.body?.[0] || null;

  const summaryBefore = await req('/api/enrollments/summary', {}, token);
  assert(summaryBefore.status === 200, 'summary failed');
  const totalBefore = summaryBefore.body.total;

  // 1) Create with provider
  const withProvider = await req('/api/enrollments', {
    method: 'POST',
    body: JSON.stringify({
      payerId,
      payerPlanId: plan.id,
      practiceId: practice?.id || facility.practiceId || null,
      facilityId: facility.id,
      providerId: linkedProvider?.id || null,
      subject: 'Smoke With Provider',
      status: 'NOT_STARTED',
      assignedTo: email,
      notes: 'smoke create with provider'
    })
  }, token);
  assert(withProvider.status === 201, `create with provider failed: ${withProvider.status} ${JSON.stringify(withProvider.body)}`);
  assert(withProvider.body.applicationNo, 'applicationNo missing');
  assert(withProvider.body.facilityId === facility.id, 'facility not saved');
  if (linkedProvider?.id) {
    assert(withProvider.body.providerId === linkedProvider.id, 'provider not saved');
    assert(withProvider.body.providerName && !/undefined|null/i.test(withProvider.body.providerName), 'providerName blank');
  }
  console.log('OK create with provider', withProvider.body.applicationNo, withProvider.body.providerName);

  // 2) Create without provider — facility is responsible entity
  const withoutProvider = await req('/api/enrollments', {
    method: 'POST',
    body: JSON.stringify({
      payerId,
      payerPlanId: plan.id,
      practiceId: practice?.id || facility.practiceId || null,
      facilityId: facility.id,
      providerId: null,
      subject: 'Smoke Facility Only',
      status: 'NOT_STARTED',
      notes: 'smoke create facility-only'
    })
  }, token);
  assert(withoutProvider.status === 201, `create without provider failed: ${withoutProvider.status} ${JSON.stringify(withoutProvider.body)}`);
  assert(withoutProvider.body.applicationNo, 'applicationNo missing on facility-only');
  assert(withoutProvider.body.applicationNo !== withProvider.body.applicationNo, 'application numbers must be unique');
  assert(!withoutProvider.body.providerId, 'providerId should be null');
  assert(withoutProvider.body.facilityId === facility.id, 'facility must remain linked');
  assert(
    withoutProvider.body.providerName === (withoutProvider.body.facility?.name || facility.name),
    `providerName should fall back to facility; got ${withoutProvider.body.providerName}`
  );
  console.log('OK create without provider', withoutProvider.body.applicationNo, 'providerName=', withoutProvider.body.providerName);

  // 3) Persistence / list
  const list = await req('/api/enrollments?page=1&pageSize=50&q=Smoke', {}, token);
  assert(list.status === 200, 'list failed');
  const ids = (list.body.data || []).map((r: any) => r.id);
  assert(ids.includes(withProvider.body.id), 'with-provider not in list');
  assert(ids.includes(withoutProvider.body.id), 'without-provider not in list');
  const facilityOnlyRow = (list.body.data || []).find((r: any) => r.id === withoutProvider.body.id);
  assert(facilityOnlyRow.providerName === (facilityOnlyRow.facility?.name || facility.name), 'list providerName fallback failed');
  console.log('OK list persistence and providerName fallback');

  // 4) Filters
  const byPayer = await req(`/api/enrollments?page=1&pageSize=25&payerId=${payerId}`, {}, token);
  assert(byPayer.status === 200 && (byPayer.body.data || []).length > 0, 'payer filter failed');
  const byFacility = await req(`/api/enrollments?page=1&pageSize=25&facilityId=${facility.id}`, {}, token);
  assert(byFacility.status === 200 && (byFacility.body.data || []).some((r: any) => r.id === withoutProvider.body.id), 'facility filter failed');
  const byStatus = await req('/api/enrollments?page=1&pageSize=25&status=NOT_STARTED', {}, token);
  assert(byStatus.status === 200, 'status filter failed');
  console.log('OK payer/facility/status filters');

  // 5) Edit preserves relationships + follow-up / days fields
  const lastFollowUpAt = '2026-11-05T00:00:00.000Z';
  const nextFollowUpAt = '2026-11-20T00:00:00.000Z';
  const submittedAt = '2026-11-01T00:00:00.000Z';
  const patched = await req(`/api/enrollments/${withoutProvider.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      notes: 'smoke edited',
      subject: 'Smoke Facility Only (edited)',
      assignedTo: email,
      submittedAt,
      lastFollowUpAt,
      nextFollowUpAt,
      facilityId: facility.id,
      providerId: null,
      payerId,
      payerPlanId: plan.id
    })
  }, token);
  assert(patched.status === 200, `patch failed: ${patched.status} ${JSON.stringify(patched.body)}`);
  assert(patched.body.facilityId === facility.id, 'facility lost after edit');
  assert(!patched.body.providerId, 'provider unexpectedly set after edit');
  assert(patched.body.applicationNo === withoutProvider.body.applicationNo, 'applicationNo changed on edit');
  assert(patched.body.lastFollowUpAt, 'lastFollowUpAt missing after edit');
  assert(patched.body.nextFollowUpAt, 'nextFollowUpAt missing after edit');
  assert(typeof patched.body.daysConsumed === 'number', 'daysConsumed missing after edit');
  assert(patched.body.assigneeName || patched.body.assignedTo === email, 'assignee not enriched');
  assert(
    patched.body.providerName === (patched.body.facility?.name || facility.name),
    'providerName fallback lost after edit'
  );
  console.log('OK edit preserves relationships, follow-ups, daysConsumed, applicationNo');

  // 5b) Highlight / unhighlight persistence (does not change status)
  const statusBeforeHighlight = patched.body.status;
  const highlighted = await req(`/api/enrollments/${withoutProvider.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ highlighted: true })
  }, token);
  assert(highlighted.status === 200, `highlight failed: ${highlighted.status} ${JSON.stringify(highlighted.body)}`);
  assert(highlighted.body.highlighted === true, 'highlighted not true');
  assert(highlighted.body.status === statusBeforeHighlight, 'highlight must not change status');

  const refreshed = await req(`/api/enrollments/${withoutProvider.body.id}`, {}, token);
  assert(refreshed.status === 200 && refreshed.body.highlighted === true, 'highlight not persisted after refresh');

  const unhighlighted = await req(`/api/enrollments/${withoutProvider.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ highlighted: false })
  }, token);
  assert(unhighlighted.status === 200 && unhighlighted.body.highlighted === false, 'unhighlight failed');
  assert(unhighlighted.body.status === statusBeforeHighlight, 'unhighlight must not change status');
  const refreshed2 = await req(`/api/enrollments/${withoutProvider.body.id}`, {}, token);
  assert(refreshed2.status === 200 && refreshed2.body.highlighted === false, 'unhighlight not persisted');
  console.log('OK highlight/unhighlight persistence without status change');

  // 6) Summary / overdue / mine
  const summaryAfter = await req('/api/enrollments/summary', {}, token);
  assert(summaryAfter.status === 200, 'summary after failed');
  assert(summaryAfter.body.total >= totalBefore + 2, `KPI total did not increase (${totalBefore} -> ${summaryAfter.body.total})`);
  const statusSum = Object.values(summaryAfter.body.byStatus || {}).reduce((a: number, b: any) => a + Number(b || 0), 0);
  assert(statusSum === summaryAfter.body.total, `status KPI double-count risk: sum=${statusSum} total=${summaryAfter.body.total}`);
  const mine = await req('/api/enrollments?mine=1&page=1&pageSize=25', {}, token);
  assert(mine.status === 200, 'mine view failed');
  const overdue = await req('/api/enrollments?overdue=1&page=1&pageSize=25', {}, token);
  assert(overdue.status === 200, 'overdue view failed');
  console.log('OK summary KPIs, mine, overdue');

  // 7) Existing seed enrollments still load
  const all = await req('/api/enrollments?page=1&pageSize=25', {}, token);
  assert(all.status === 200 && (all.body.data || []).length > 0, 'existing enrollments missing');
  console.log('OK existing enrollments still work');

  // Reject create without facility
  const bad = await req('/api/enrollments', {
    method: 'POST',
    body: JSON.stringify({ payerPlanId: plan.id, subject: 'missing facility' })
  }, token);
  assert(bad.status === 400, `expected 400 without facility, got ${bad.status}`);
  console.log('OK validation rejects missing facility');

  // 8) Activity chat is enrollment-specific and persists
  const enrA = withProvider.body.id as string;
  const enrB = withoutProvider.body.id as string;
  const postA = await req(`/api/enrollments/${enrA}/activities`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Called payer about application status', activityType: 'MESSAGE' })
  }, token);
  assert(postA.status === 201 && postA.body?.id, `activity create failed: ${postA.status} ${JSON.stringify(postA.body)}`);
  assert(postA.body.enrollmentId === enrA, 'activity linked to wrong enrollment');

  const listA = await req(`/api/enrollments/${enrA}/activities`, {}, token);
  assert(listA.status === 200, 'activity list A failed');
  assert((listA.body.data || []).some((a: any) => a.id === postA.body.id), 'activity missing after refresh');

  const listB = await req(`/api/enrollments/${enrB}/activities`, {}, token);
  assert(listB.status === 200, 'activity list B failed');
  assert(!(listB.body.data || []).some((a: any) => a.id === postA.body.id), 'enrollments must not share conversations');
  console.log('OK enrollment activity isolation and persistence');

  // 9) Follow-up completion / schedule update Last / Next without chat alone changing Last
  const beforeLast = refreshed2.body.lastFollowUpAt;
  const chatOnly = await req(`/api/enrollments/${enrB}/activities`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Ordinary note should not bump last follow-up', activityType: 'MESSAGE' })
  }, token);
  assert(chatOnly.status === 201, 'chat-only activity failed');
  const afterChat = await req(`/api/enrollments/${enrB}`, {}, token);
  assert(afterChat.body.lastFollowUpAt === beforeLast, 'MESSAGE must not update lastFollowUpAt');

  const completedFollowUp = await req(`/api/enrollments/${enrB}/activities`, {
    method: 'POST',
    body: JSON.stringify({
      body: 'Follow-up completed with payer',
      activityType: 'FOLLOW_UP_COMPLETED',
      completedAt: '2026-11-09'
    })
  }, token);
  assert(completedFollowUp.status === 201, `follow-up complete failed: ${completedFollowUp.status}`);
  const afterComplete = await req(`/api/enrollments/${enrB}`, {}, token);
  assert(String(afterComplete.body.lastFollowUpAt || '').startsWith('2026-11-09'), 'lastFollowUpAt not updated from completed follow-up');

  const scheduled = await req(`/api/enrollments/${enrB}/activities`, {
    method: 'POST',
    body: JSON.stringify({
      body: 'Scheduled next payer call',
      activityType: 'FOLLOW_UP_SCHEDULED',
      nextFollowUpAt: '2026-11-20'
    })
  }, token);
  assert(scheduled.status === 201, `follow-up schedule failed: ${scheduled.status}`);
  const afterSchedule = await req(`/api/enrollments/${enrB}`, {}, token);
  assert(String(afterSchedule.body.nextFollowUpAt || '').startsWith('2026-11-20'), 'nextFollowUpAt not updated from schedule');
  console.log('OK follow-up activity updates Last/Next correctly');

  // 10) Approval details save without creating duplicate enrollment / without auto-approving
  const statusBeforeApproval = afterSchedule.body.status;
  const approvalSave = await req(`/api/enrollments/${enrB}/approval`, {
    method: 'PUT',
    body: JSON.stringify({
      payerEnrollmentId: 'PAYER-REF-SMOKE-9001',
      effectiveAt: '2026-12-01',
      revalidationAt: '2027-12-01',
      notes: 'Smoke approval letter received'
    })
  }, token);
  assert(approvalSave.status === 200, `approval save failed: ${approvalSave.status} ${JSON.stringify(approvalSave.body)}`);
  assert(approvalSave.body.status === statusBeforeApproval, 'approval form must not change status');
  assert(approvalSave.body.details?.payerEnrollmentId === 'PAYER-REF-SMOKE-9001', 'payer enrollment id not saved');

  const approvalGet = await req(`/api/enrollments/${enrB}/approval`, {}, token);
  assert(approvalGet.status === 200, 'approval get failed');
  assert(approvalGet.body.details?.payerEnrollmentId === 'PAYER-REF-SMOKE-9001', 'approval details not rebound');
  assert(String(approvalGet.body.details?.effectiveAt || '').startsWith('2026-12-01'), 'effective date missing');
  assert(String(approvalGet.body.details?.revalidationAt || '').startsWith('2027-12-01'), 'revalidation date missing');

  const detailAfterApproval = await req(`/api/enrollments/${enrB}`, {}, token);
  assert(detailAfterApproval.body.id === enrB, 'approval created a different enrollment id');
  assert(detailAfterApproval.body.applicationNo === withoutProvider.body.applicationNo, 'approval changed applicationNo / duplicated enrollment');
  assert(detailAfterApproval.body.referenceNo === 'PAYER-REF-SMOKE-9001', 'referenceNo not synced from approval');
  console.log('OK approval details persist without duplicate enrollment or auto-approve');

  // 11) Status change writes activity history
  const preparing = await req(`/api/enrollments/${enrB}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'PREPARING' })
  }, token);
  // may already be PREPARING from earlier patch — move through READY if needed
  let statusTarget = preparing.body.status;
  if (statusTarget === 'NOT_STARTED' || preparing.status === 200) {
    const toPrep = preparing.body.status === 'PREPARING'
      ? preparing
      : await req(`/api/enrollments/${enrB}`, { method: 'PATCH', body: JSON.stringify({ status: 'PREPARING' }) }, token);
    assert(toPrep.status === 200, `status to PREPARING failed: ${toPrep.status} ${JSON.stringify(toPrep.body)}`);
    statusTarget = toPrep.body.status;
  }
  const activitiesAfterStatus = await req(`/api/enrollments/${enrB}/activities`, {}, token);
  assert(
    (activitiesAfterStatus.body.data || []).some((a: any) => a.activityType === 'STATUS_CHANGE' || a.activityType === 'APPROVAL_UPDATE'),
    'expected status/approval activity history entries'
  );
  console.log('OK status/approval events appear in activity timeline');

  // 12) Another authorized user can see activity; READ_ONLY cannot post
  const specialistLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'enrollment@example.com', password })
  });
  assert(specialistLogin.status === 200 && specialistLogin.body?.token, 'enrollment specialist login failed');
  const peerView = await req(`/api/enrollments/${enrA}/activities`, {}, specialistLogin.body.token);
  assert(peerView.status === 200, 'authorized peer cannot view activity');
  assert((peerView.body.data || []).some((a: any) => a.id === postA.body.id), 'peer cannot see persisted activity');

  const { prisma } = await import('../src/lib/prisma');
  const bcryptMod = await import('bcryptjs');
  const bcrypt = (bcryptMod as any).default || bcryptMod;
  const readonlyEmail = 'readonly-smoke@example.com';
  const hash = await bcrypt.hash(password, 8);
  await prisma.user.upsert({
    where: { email: readonlyEmail },
    update: { role: 'READ_ONLY', active: true, passwordHash: hash, name: 'Smoke Read Only' },
    create: { email: readonlyEmail, name: 'Smoke Read Only', role: 'READ_ONLY', passwordHash: hash, active: true }
  });
  const readonlyLogin = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: readonlyEmail, password })
  });
  assert(readonlyLogin.status === 200 && readonlyLogin.body?.token, 'read-only login failed');
  const denied = await req(`/api/enrollments/${enrA}/activities`, {
    method: 'POST',
    body: JSON.stringify({ body: 'should fail', activityType: 'MESSAGE' })
  }, readonlyLogin.body.token);
  assert(denied.status === 403, `expected 403 for read-only activity post, got ${denied.status}`);
  console.log('OK peer visibility and permissions block unauthorized activity posts');

  console.log('Enrollment smoke checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
