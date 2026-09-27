// Unit tests for the evaluation harness's own arithmetic and parsing — the
// numbers reported for the SIH metrics are only as good as these functions.
// Run: node --test eval/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, iou, confusion, parseStateEvents, parseDecisions, parsePerf, phaseBreakdown, LOCAL_MECHANISMS,
  parseSpEvents, parseTaskMetrics, successRate, averageTotalLatencyMs, replanRate,
  localReasoningRate, visionEscalationRate, cloudEscalationRate, pctCompletedWithoutCloud,
} from '../lib/metrics.mjs';
import { toIntervals, aggregate } from '../lib/resource-monitor.mjs';
import { casePath, visualCasePages, loadJson } from '../lib/fixtures.mjs';
import { extractV1HelperSource } from '../lib/page-probe.mjs';
import { inferenceWindows } from '../lib/harness.mjs';

test('summarize: mean/median/min/max over finite values, even and odd n', () => {
  assert.deepEqual(summarize([3, 1, 2]), { n: 3, mean: 2, median: 2, min: 1, max: 3 });
  assert.deepEqual(summarize([4, 1, 3, 2]), { n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
  assert.deepEqual(summarize([null, NaN, 5]), { n: 1, mean: 5, median: 5, min: 5, max: 5 });
  assert.deepEqual(summarize([]), { n: 0, mean: null, median: null, min: null, max: null });
});

test('iou: identical, disjoint, and half-overlapping boxes', () => {
  const a = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, { x: 20, y: 20, width: 5, height: 5 }), 0);
  // overlap 5x10=50, union 100+100-50=150
  assert.equal(iou(a, { x: 5, y: 0, width: 10, height: 10 }), 50 / 150);
});

test('confusion: counts, precision/recall/F1, and undefined ratios stay null', () => {
  const rows = [
    { truth: true, predicted: true }, { truth: true, predicted: true }, { truth: true, predicted: false },
    { truth: false, predicted: true }, { truth: false, predicted: false },
  ];
  const c = confusion(rows);
  assert.deepEqual([c.tp, c.fp, c.tn, c.fn], [2, 1, 1, 1]);
  assert.equal(c.precision, 2 / 3);
  assert.equal(c.recall, 2 / 3);
  assert.equal(c.f1, 2 / 3);
  const none = confusion([{ truth: false, predicted: false }]);
  assert.equal(none.precision, null, '0/0 precision must be null, not 0 or 1');
  assert.equal(none.recall, null);
});

// Real log lines, copied verbatim from a live run of the extension.
const LIVE_LINES = [
  '[SP:V2] [2026-09-25T07:25:02.017Z] STATE IDLE → PLANNING  event=GOAL_SUBMITTED  goal="Click the button with the warning icon"',
  '[SP:DecisionRouter] Layer 3 router=vision (no text candidates) Moondream availability=true (15ms)',
  '[SP:V2:PERF] visionLatencyMs=14940 model=moondream',
  '[SP:DecisionRouter] Layer 3 sole unlabeled interactive candidate resolved structurally -> elementId=el_7 (no model invoked)',
  '[SP:V2:PERF] domMs=4 goalVerifyMs=1 layer1Ms=0 layer2Ms=3 qwenMs=0 cloudMs=0 screenshotMs=155 postActionVerifyMs=0 navigationWaitMs=0 totalPlanningMs=15116 l3Layer=local_vision',
  '[SP:V2] [2026-09-25T07:25:17.160Z] STATE PLANNING → EXECUTING  event=PLAN_RECEIVED  intent="click_x"',
  '[SP:V2] [2026-09-25T07:25:17.168Z] STATE EXECUTING → AWAITING_USER  event=ELEMENT_READY  intent="click_x"',
  '[SP:V2] [2026-09-25T07:25:17.273Z] STATE AWAITING_USER → VALIDATING  event=USER_ACTED  trigger="click"',
  '[SP:V2:PERF] stage=post_action_verify postActionVerifyMs=157 verdict=INCONCLUSIVE trigger=click',
  '[SP:V2] [2026-09-25T07:25:17.438Z] STATE VALIDATING → EXECUTING  event=VALIDATION_PASSED  verdict="INCONCLUSIVE"',
  '[SP:V2] [2026-09-25T07:25:17.441Z] STATE EXECUTING → PLANNING  event=REPLAN_TRIGGERED  intent="click_x"',
  '[SP:V2] [2026-09-25T07:25:17.450Z] STATE PLANNING → COMPLETE  event=PLAN_COMPLETE  source="verifier"',
];

test('parseStateEvents / phaseBreakdown: real log → phases that sum to the total', () => {
  const events = parseStateEvents(LIVE_LINES);
  assert.equal(events.length, 7);
  const p = phaseBreakdown(events);
  assert.equal(p.outcome, 'COMPLETE');
  assert.equal(p.totalMs, 15433);        // 07:25:02.017 → 07:25:17.450
  assert.equal(p.planningMs, 15143 + 9); // 02.017→17.160 plus 17.441→17.450
  assert.equal(p.highlightMs, 8 + 3);    // 17.160→17.168 plus 17.438→17.441
  assert.equal(p.userActionMs, 105);     // 17.168→17.273
  assert.equal(p.verificationMs, 165);   // 17.273→17.438
  assert.equal(p.planningMs + p.highlightMs + p.userActionMs + p.verificationMs + p.otherMs, p.totalMs);
  assert.equal(p.systemMs, p.totalMs - p.userActionMs);
  assert.equal(p.cycles, 2);
});

test('phaseBreakdown: no terminal state → INCOMPLETE, never reported as COMPLETE', () => {
  const p = phaseBreakdown(parseStateEvents(LIVE_LINES.slice(0, 7)));
  assert.equal(p.outcome, 'INCOMPLETE');
});

test('parseDecisions / parsePerf: mechanism attribution and model timings from real lines', () => {
  assert.deepEqual(parseDecisions(LIVE_LINES), ['structural_fallback']);
  assert.ok(LOCAL_MECHANISMS.has('structural_fallback'));
  assert.ok(!LOCAL_MECHANISMS.has('cloud'));
  const perf = parsePerf(LIVE_LINES);
  assert.deepEqual(perf.visionLatencyMs, [14940]);
  assert.deepEqual(perf.totalPlanningMs, [15116]);
  assert.deepEqual(perf.screenshotMs, [155]);
  assert.deepEqual(perf.postActionVerifyMs, [157]);
  assert.deepEqual(perf.qwenLatencyMs, []);
});

test('inferenceWindows: Moondream window spans router start → adapter latency line', () => {
  const entries = LIVE_LINES.map((text, i) => ({ t: 1000 + i * 10, text }));
  const w = inferenceWindows(entries);
  assert.deepEqual(w.moondream, [{ start: 1010, end: 1020 }]);
  assert.deepEqual(w.qwen, []);
});

test('toIntervals: per-process CPU% = ΔCPU time / Δwall / cores; models attributed by blob', () => {
  const blobMap = { 'sha256-aaa': 'qwen2.5-coder:7b' };
  const mk = (t, cpu100ns) => ({
    t, sysCpu: 50, freeKB: 1024 * 1024, totalKB: 4 * 1024 * 1024,
    procs: [
      { pid: 1, name: 'llama-server.exe', model: 'sha256-aaa', cpu100ns, ws: 100 * 1024 ** 2 },
      { pid: 2, name: 'chrome.exe', path: 'C:\\Users\\x\\AppData\\Local\\Chrome\\chrome.exe', cpu100ns, ws: 50 * 1024 ** 2 },
    ],
  });
  // 1 s of wall time, 2 s of CPU time consumed, 4 logical cores → 50 % of the machine.
  const rows = toIntervals([mk(0, 0), mk(1000, 2e7)], blobMap, 4);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cpu['model:qwen2.5-coder:7b'], 50);
  assert.equal(rows[0].ramMB['model:qwen2.5-coder:7b'], 100);
  assert.equal(rows[0].systemRamUsedMB, 3 * 1024);
  assert.ok(!('benchmark-chromium' in rows[0].cpu), "the user's own (non-Playwright) Chrome must be excluded");
});

test('aggregate: overlap windowing, avg/peak, and n', () => {
  const rows = [
    { t0: 0, t1: 1000, systemCpuPct: 10, systemRamUsedMB: 100, cpu: { g: 10 }, ramMB: { g: 1 } },
    { t0: 1000, t1: 2000, systemCpuPct: 30, systemRamUsedMB: 300, cpu: { g: 30 }, ramMB: { g: 3 } },
    { t0: 2000, t1: 3000, systemCpuPct: 90, systemRamUsedMB: 900, cpu: { g: 90 }, ramMB: { g: 9 } },
  ];
  const a = aggregate(rows, [{ start: 900, end: 1100 }]); // overlaps the first two intervals
  assert.equal(a.intervals, 2);
  assert.equal(a.systemCpuPct.avg, 20);
  assert.equal(a.systemCpuPct.peak, 30);
  assert.equal(a.perGroup.g.ramMB.peak, 3);
  assert.equal(aggregate(rows, [{ start: 5000, end: 6000 }]).intervals, 0);
});

test('fixtures: page paths and titles never leak case ids to the system under test', () => {
  const { cases } = loadJson('eval/ground-truth/visual-cases.json');
  const pages = visualCasePages(cases);
  for (const c of cases) {
    const p = casePath(cases, c.id);
    assert.match(p, /^\/page\/\d+$/);
    if (!c.htmlFile) assert.ok(!pages[p].includes(`<title>${c.id}`), `title must not contain the case id (${c.id})`);
  }
});

test('ground truth: every visual case has a goal and an explicit expected target (or null)', () => {
  const { cases } = loadJson('eval/ground-truth/visual-cases.json');
  const ids = new Set();
  for (const c of cases) {
    assert.ok(c.goal && c.category && ('expectedTargetId' in c), c.id);
    assert.ok(!ids.has(c.id), `duplicate case id ${c.id}`);
    ids.add(c.id);
    if (c.expectedTargetId && c.html) assert.ok(c.html.includes(`id='${c.expectedTargetId}'`), `${c.id}: expected target must exist in its fixture`);
  }
  const gt = loadJson('eval/ground-truth/privacy-fields.json');
  for (const id of Object.keys(gt.fields)) assert.ok(gt.html.includes(`id='${id}'`), `privacy field ${id} must exist in the fixture`);
});

test('page probe: the V1 detector is sliced verbatim from content.js (never re-implemented)', () => {
  const src = extractV1HelperSource();
  assert.match(src, /function getSensitiveScreenshotRegions\(\)/);
  assert.match(src, /function getScreenshotPrivacyContext\(\)/);
  assert.match(src, /const SP_SENSITIVE_INPUT_TYPES/);
});

// ── Phase 7 — task_metrics parsing + evaluation ratios ──────────────────────

function taskMetricsLine(fields) {
  return `[SP:EVENT] ${JSON.stringify({ event: 'task_metrics', level: 'info', ts: 1, ...fields })}`;
}

test('parseSpEvents: only well-formed [SP:EVENT] lines are parsed; other lines and malformed JSON are skipped', () => {
  const lines = [
    'some unrelated console line',
    taskMetricsLine({ outcome: 'complete' }),
    '[SP:EVENT] not valid json',
    '[SP:V2:PERF] domMs=5 layer1Ms=0',
  ];
  const out = parseSpEvents(lines);
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'task_metrics');
});

test('parseTaskMetrics: extracts only task_metrics events, in order, ignoring other [SP:EVENT] events', () => {
  const lines = [
    `[SP:EVENT] ${JSON.stringify({ event: 'layer3_qwen_ok', level: 'info', ts: 1 })}`,
    taskMetricsLine({ outcome: 'complete', cycles: { total: 2, routed: 2, skipped: 0 } }),
    taskMetricsLine({ outcome: 'failed', cycles: { total: 1, routed: 1, skipped: 0 } }),
  ];
  const out = parseTaskMetrics(lines);
  assert.equal(out.length, 2);
  assert.equal(out[0].outcome, 'complete');
  assert.equal(out[1].outcome, 'failed');
});

test('successRate: fraction of tasks with outcome==="complete"; null when no tasks', () => {
  assert.equal(successRate([]), null);
  assert.equal(successRate([{ outcome: 'complete' }, { outcome: 'failed' }, { outcome: 'complete' }]), 2 / 3);
});

test('averageTotalLatencyMs: mean over tasks that have a numeric totalLatencyMs; null when none do', () => {
  assert.equal(averageTotalLatencyMs([{ totalLatencyMs: null }]), null);
  assert.equal(averageTotalLatencyMs([{ totalLatencyMs: 100 }, { totalLatencyMs: 300 }]), 200);
});

test('replanRate: pooled replans-per-completed-action across the run set, not averaged per task first', () => {
  const runs = [
    { replans: { total: 2 }, actions: { completed: 2 } },
    { replans: { total: 4 }, actions: { completed: 8 } },
  ];
  // pooled: (2+4) / (2+8) = 0.6 — NOT the average of 1.0 and 0.5 (0.75)
  assert.equal(replanRate(runs), 0.6);
  assert.equal(replanRate([{ replans: { total: 0 }, actions: { completed: 0 } }]), null);
});

test('local/vision/cloud escalation rates are shares of ROUTED cycles, and localReasoningRate combines qwen+vision', () => {
  const runs = [
    { cycles: { routed: 10 }, layerCounts: { deterministic: 4, mlGrounding: 3, localQwen: 2, localVision: 1, cloud: 0 } },
  ];
  assert.equal(localReasoningRate(runs), 0.3);
  assert.equal(visionEscalationRate(runs), 0.1);
  assert.equal(cloudEscalationRate(runs), 0);
  assert.equal(localReasoningRate([]), null);
});

test('pctCompletedWithoutCloud: of completed tasks only, the share that made zero cloud calls', () => {
  const runs = [
    { outcome: 'complete', layerCounts: { cloud: 0 } },
    { outcome: 'complete', layerCounts: { cloud: 1 } },
    { outcome: 'failed', layerCounts: { cloud: 0 } }, // excluded — not completed
  ];
  assert.equal(pctCompletedWithoutCloud(runs), 0.5);
  assert.equal(pctCompletedWithoutCloud([{ outcome: 'failed', layerCounts: { cloud: 0 } }]), null);
});
