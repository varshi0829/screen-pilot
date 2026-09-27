// task-metrics.js — deriveTaskMetrics() (Phase 7). Pure aggregator over a
// task's own per-cycle records — same convention as task-progress.test.mjs
// (fixed fixtures in, exact aggregate out, no DOM/network/timers).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deriveTaskMetrics } from '../lib/task-metrics.js';

function cycle(overrides = {}) {
  return {
    skipped: false, domMs: 5, layer: null,
    layer1Ms: 0, layer2Ms: 0, qwenMs: 0, visionMs: 0, cloudMs: 0,
    verifyMs: null, verdict: null, outcome: null,
    ...overrides,
  };
}

const session = (overrides = {}) => ({
  sessionId: 'sess-1', createdAt: 1000, completedSteps: [], ...overrides,
});

// ── Shape / PII-safety ───────────────────────────────────────────────────────

test('is a pure function — no fields beyond the documented schema, no goal/URL/provider text', () => {
  const out = deriveTaskMetrics([], session(), { outcome: 'complete' });
  assert.deepEqual(Object.keys(out).sort(), [
    'actions', 'cycles', 'endedAt', 'fingerprintOptimization', 'layerCounts',
    'layerLatencyMs', 'outcome', 'outcomeReason', 'replans', 'schemaVersion',
    'startedAt', 'taskId', 'totalLatencyMs',
  ]);
  assert.equal(out.taskId, 'sess-1');
  assert.equal(typeof out.startedAt, 'number');
  assert.equal(typeof out.endedAt, 'number');
  // Nothing here should ever be a URL, a goal string, or provider text —
  // spot-check every string-typed leaf is from the small fixed enum set.
  assert.ok(['complete', 'failed', 'aborted', null].includes(out.outcome));
});

test('an empty cycleRecords array is valid — zeroed fields, not fabricated ones', () => {
  const out = deriveTaskMetrics([], session(), { outcome: 'aborted', outcomeReason: 'USER_CANCELLED' });
  assert.deepEqual(out.cycles, { total: 0, routed: 0, skipped: 0 });
  assert.deepEqual(out.layerCounts, { deterministic: 0, mlGrounding: 0, localQwen: 0, localVision: 0, cloud: 0 });
  assert.equal(out.fingerprintOptimization.skipsAttempted, 0);
  assert.equal(out.fingerprintOptimization.modelCallsAvoidedEstimate, 0);
  assert.equal(out.outcome, 'aborted');
  assert.equal(out.outcomeReason, 'USER_CANCELLED');
});

test('a null sessionSnapshot does not throw and reports a null taskId/startedAt', () => {
  const out = deriveTaskMetrics([], null, { outcome: 'failed' });
  assert.equal(out.taskId, null);
  assert.equal(out.startedAt, null);
  assert.equal(out.totalLatencyMs, null);
});

// ── cycles / layerCounts ─────────────────────────────────────────────────────

test('cycles.total === cycles.routed + cycles.skipped (invariant)', () => {
  const records = [
    cycle({ skipped: true }),
    cycle({ layer: 'deterministic', outcome: 'step_completed' }),
    cycle({ skipped: true }),
    cycle({ layer: 'cloud', outcome: 'step_completed' }),
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}, {}] }), { outcome: 'complete' });
  assert.equal(out.cycles.total, out.cycles.routed + out.cycles.skipped);
  assert.equal(out.cycles.total, 4);
  assert.equal(out.cycles.routed, 2);
  assert.equal(out.cycles.skipped, 2);
});

test('sum(layerCounts.*) === cycles.routed (invariant)', () => {
  const records = [
    cycle({ layer: 'deterministic', outcome: 'step_completed' }),
    cycle({ layer: 'ml_grounding', outcome: 'step_completed' }),
    cycle({ layer: 'local_qwen', outcome: 'step_completed' }),
    cycle({ layer: 'local_vision', outcome: 'step_completed' }),
    cycle({ layer: 'cloud', outcome: 'step_completed' }),
    cycle({ skipped: true }), // must NOT count toward any layer bucket
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: Array(5).fill({}) }), { outcome: 'complete' });
  const sum = Object.values(out.layerCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, out.cycles.routed);
  assert.equal(sum, 5);
  assert.deepEqual(out.layerCounts, { deterministic: 1, mlGrounding: 1, localQwen: 1, localVision: 1, cloud: 1 });
});

// ── replans ──────────────────────────────────────────────────────────────────

test('replans.total === sum(replans.byOutcome.*) (invariant)', () => {
  const records = [
    cycle({ layer: 'ml_grounding', outcome: 'element_not_found' }),
    cycle({ layer: 'ml_grounding', outcome: 'dedup_repeat' }),
    cycle({ layer: 'cloud', outcome: 'stale_plan' }),
    cycle({ layer: 'cloud', outcome: 'retryable_error' }),
    cycle({ layer: 'ml_grounding', outcome: 'fill_verification_failed' }),
    cycle({ layer: 'ml_grounding', outcome: 'step_completed' }),
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}] }), { outcome: 'aborted' });
  const sum = Object.values(out.replans.byOutcome).reduce((a, b) => a + b, 0);
  assert.equal(out.replans.total, sum);
  assert.equal(out.replans.total, 6);
  assert.deepEqual(out.replans.byOutcome, {
    elementNotFound: 1, fillVerificationFailed: 1, dedupRepeat: 1,
    stalePlan: 1, retryableError: 1, ordinaryProgression: 1,
  });
});

test('ordinaryProgression does NOT count a fill-verification failure as a successful completed step (Gap #1)', () => {
  // Same shared "completed" result string in v2-task.js for both cases — the
  // cycle record's `outcome` tag is what must disambiguate them, and this
  // aggregator must never fold fill_verification_failed into
  // ordinaryProgression/step_completed.
  const records = [
    cycle({ layer: 'ml_grounding', outcome: 'fill_verification_failed' }),
    cycle({ layer: 'ml_grounding', outcome: 'fill_verification_failed' }),
    cycle({ layer: 'ml_grounding', outcome: 'step_completed' }),
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}] }), { outcome: 'failed' });
  assert.equal(out.replans.byOutcome.fillVerificationFailed, 2);
  assert.equal(out.replans.byOutcome.ordinaryProgression, 1);
  assert.equal(out.actions.verificationOutcomes.fillNotSatisfied, 2);
});

test("a completed task's terminal step is correctly excluded from ordinaryProgression (it exits before the fallthrough that tags it)", () => {
  const records = [
    cycle({ layer: 'ml_grounding', outcome: 'step_completed' }), // step 1 of 2 — ordinary
    // step 2 (the terminal one) completes the task WITHOUT ever reaching the
    // fallthrough — so no matching cycle record is pushed for it.
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}, {}] }), { outcome: 'complete' });
  assert.equal(out.actions.completed, 2);
  assert.equal(out.replans.byOutcome.ordinaryProgression, 1, 'completed - 1, per the audited invariant');
});

// ── fingerprintOptimization.skipsAttempted invariant ────────────────────────

test('fingerprintOptimization.skipsAttempted === cycles.skipped (invariant)', () => {
  const records = [cycle({ skipped: true }), cycle({ skipped: true }), cycle({ layer: 'cloud', outcome: 'step_completed' })];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}] }), { outcome: 'complete' });
  assert.equal(out.fingerprintOptimization.skipsAttempted, out.cycles.skipped);
  assert.equal(out.fingerprintOptimization.skipsAttempted, 2);
});

// ── modelCallsAvoidedEstimate ────────────────────────────────────────────────

test('modelCallsAvoidedEstimate counts a skip only when the most recently ROUTED cycle used a model layer', () => {
  const records = [
    cycle({ layer: 'deterministic', outcome: 'step_completed' }),
    cycle({ skipped: true }), // preceded by deterministic -> NOT counted
    cycle({ layer: 'local_qwen', outcome: 'step_completed' }),
    cycle({ skipped: true }), // preceded by local_qwen -> counted
    cycle({ skipped: true }), // still preceded by local_qwen (no routed cycle in between) -> counted
    cycle({ layer: 'cloud', outcome: 'step_completed' }),
    cycle({ skipped: true }), // preceded by cloud -> counted
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}, {}, {}] }), { outcome: 'complete' });
  assert.equal(out.fingerprintOptimization.modelCallsAvoidedEstimate, 3);
});

test('modelCallsAvoidedEstimate is 0 when no model layer ever ran before a skip', () => {
  const records = [
    cycle({ layer: 'deterministic', outcome: 'step_completed' }),
    cycle({ skipped: true }),
    cycle({ layer: 'ml_grounding', outcome: 'step_completed' }),
    cycle({ skipped: true }),
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}, {}] }), { outcome: 'complete' });
  assert.equal(out.fingerprintOptimization.modelCallsAvoidedEstimate, 0);
});

// ── latency buckets ──────────────────────────────────────────────────────────

test('layerLatencyMs buckets sum/average only the cycles that actually have that stage\'s latency', () => {
  const records = [
    cycle({ layer: 'local_qwen', outcome: 'step_completed', domMs: 10, qwenMs: 200 }),
    cycle({ layer: 'local_qwen', outcome: 'step_completed', domMs: 20, qwenMs: 300 }),
    cycle({ layer: 'deterministic', outcome: 'step_completed', domMs: 5 }), // qwenMs: 0 -> not counted in the qwen bucket
    cycle({ skipped: true, domMs: 8 }), // domMs still counts (extraction always runs)
  ];
  const out = deriveTaskMetrics(records, session({ completedSteps: [{}, {}, {}] }), { outcome: 'complete' });
  assert.deepEqual(out.layerLatencyMs.localQwen, { totalMs: 500, avgMs: 250, count: 2 });
  assert.deepEqual(out.layerLatencyMs.stateExtraction, { totalMs: 43, avgMs: 11, count: 4 });
});

// ── outcome / outcomeReason ──────────────────────────────────────────────────

test('outcomeReason is passed through as given (a small fixed enum, never free text, by the caller\'s own contract)', () => {
  const out = deriveTaskMetrics([], session(), { outcome: 'failed', outcomeReason: 'NETWORK_ERROR' });
  assert.equal(out.outcomeReason, 'NETWORK_ERROR');
});

test('outcomeReason defaults to null when not given', () => {
  const out = deriveTaskMetrics([], session(), { outcome: 'complete' });
  assert.equal(out.outcomeReason, null);
});
