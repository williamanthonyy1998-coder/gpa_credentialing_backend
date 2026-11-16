/**
 * Phase 5B — server-side scheduler (no frontend timers).
 * Uses DB locks for multi-instance safety. Graceful shutdown clears the interval.
 */
import { runGlobalAutomationTick } from './automationEngine';

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = false;

export function isAutomationSchedulerEnabled() {
  if (process.env.AUTOMATION_SCHEDULER_ENABLED === '0') return false;
  if (process.env.AUTOMATION_SCHEDULER_ENABLED === '1') return true;
  // Default on in non-production; opt-in in production via env.
  return process.env.NODE_ENV !== 'production';
}

export function automationSchedulerIntervalMs() {
  const n = Number(process.env.AUTOMATION_SCHEDULER_INTERVAL_MS || 5 * 60 * 1000);
  return Number.isFinite(n) && n >= 30_000 ? n : 5 * 60 * 1000;
}

async function tick() {
  if (stopped || running) return;
  running = true;
  try {
    await runGlobalAutomationTick('SYSTEM');
  } catch (e) {
    console.error('[automation-scheduler]', e);
  } finally {
    running = false;
  }
}

export function startAutomationScheduler() {
  if (!isAutomationSchedulerEnabled()) {
    console.log('[automation-scheduler] disabled');
    return;
  }
  if (timer) return;
  stopped = false;
  const ms = automationSchedulerIntervalMs();
  console.log(`[automation-scheduler] starting interval=${ms}ms`);
  // Delay first tick slightly so boot completes; still server-side.
  timer = setInterval(() => { void tick(); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(() => { void tick(); }, Math.min(15_000, ms));
}

export async function stopAutomationScheduler() {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Wait briefly if a tick is in flight (best-effort graceful shutdown).
  const start = Date.now();
  while (running && Date.now() - start < 10_000) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
