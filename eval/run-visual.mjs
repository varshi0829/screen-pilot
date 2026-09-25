// Evaluation metric 1 — Visual-context accuracy.
//
//   visual accuracy = correct target identifications / total evaluated runs
//
// A run is CORRECT when the FIRST element ScreenPilot highlights is the
// ground-truth expectedTargetId, or — for negative cases (expectedTargetId
// null) — when ScreenPilot highlights nothing at all. "Highlighted element" is
// read from what the extension actually rendered (its highlight ring), not
// from anything the harness computes itself.
//
// Run:  node eval/run-visual.mjs [--reps 3] [--case <id>] [--timeout 90000]
// Needs: Ollama running with qwen2.5-coder:7b and moondream; npm run build:ext.

import { startServer, launchExtensionBrowser, openPage, runGoal, ollamaPs, writeResult, machineInfo } from './lib/harness.mjs';
import { loadJson, visualCasePages, casePath, parseArgs } from './lib/fixtures.mjs';
import { parseStateEvents, parseDecisions, parsePerf, summarize, LOCAL_MECHANISMS } from './lib/metrics.mjs';

const args = parseArgs();
const reps = Number(args.reps ?? 3);
const timeoutMs = Number(args.timeout ?? 90_000);
const { cases: allCases } = loadJson('eval/ground-truth/visual-cases.json');
const cases = args.case ? allCases.filter((c) => c.id === args.case) : allCases;
if (!cases.length) throw new Error(`No case matches --case ${args.case}`);

const server = await startServer(visualCasePages(allCases));
const browser = await launchExtensionBrowser({ executionMode: 'local-qwen' });
const runs = [];

try {
  for (const c of cases) {
    for (let rep = 1; rep <= reps; rep++) {
      const loadedBefore = (await ollamaPs())?.map((m) => m.name) ?? null;
      const handle = await openPage(browser, server.origin + casePath(allCases, c.id));
      // Stop at the first highlight: accuracy is about the first pick.
      const result = await runGoal(handle, c.goal, { simulateUser: async () => false, timeoutMs });
      await handle.close();

      const events = parseStateEvents(result.lines);
      const submitted = events.find((e) => e.event === 'GOAL_SUBMITTED');
      const firstReady = events.find((e) => e.event === 'ELEMENT_READY');
      const lastState = events[events.length - 1]?.to ?? null;
      const decisions = parseDecisions(result.lines);
      const perf = parsePerf(result.lines);
      const actualTargetId = result.highlights[0]?.targetId ?? null;
      const highlighted = result.highlights.length > 0;
      const correct = c.expectedTargetId === null ? !highlighted : actualTargetId === c.expectedTargetId;
      const mechanism = decisions[decisions.length - 1] ?? null;

      const run = {
        caseId: c.id,
        category: c.category,
        rep,
        goal: c.goal,
        expectedTargetId: c.expectedTargetId,
        actualTargetId,
        executorLoggedTargetId: result.highlights[0]?.executorLoggedId ?? null,
        highlightRingIou: result.highlights[0]?.ringIou ?? null,
        highlightedTag: result.highlights[0]?.highlightedTag ?? null,
        highlightRelation: result.highlights[0]?.relation ?? null,
        correct,
        outcome: highlighted ? 'highlighted' : (result.stopReason === 'timeout' ? 'timeout' : `ended_${lastState}`),
        mechanism,
        mechanismIsLocal: mechanism ? LOCAL_MECHANISMS.has(mechanism) : null,
        decisions,
        timeToFirstHighlightMs: submitted && firstReady ? firstReady.t - submitted.t : null,
        visionLatencyMs: perf.visionLatencyMs,
        qwenLatencyMs: perf.qwenLatencyMs,
        totalPlanningMs: perf.totalPlanningMs,
        visionFailures: perf.visionFailures,
        qwenFailures: perf.qwenFailures,
        modelsLoadedBeforeRun: loadedBefore,
        wallMs: result.wallMs,
      };
      runs.push(run);
      console.log(
        `${correct ? 'CORRECT  ' : 'INCORRECT'} ${c.id} rep${rep}: expected=${c.expectedTargetId ?? '(none)'} ` +
        `actual=${actualTargetId ?? '(none)'} mechanism=${mechanism ?? '-'} outcome=${run.outcome} ` +
        `vision=${perf.visionLatencyMs.join('/') || '-'}ms qwen=${perf.qwenLatencyMs.join('/') || '-'}ms`,
      );
    }
  }
} finally {
  await browser.close();
  await server.close();
}

// ── Aggregation ─────────────────────────────────────────────────────────────
function rate(rs) {
  const correct = rs.filter((r) => r.correct).length;
  return { correct, total: rs.length, accuracy: rs.length ? correct / rs.length : null };
}
const groupBy = (key) => Object.fromEntries(
  [...new Set(runs.map((r) => r[key] ?? 'none'))].map((k) => [k, rate(runs.filter((r) => (r[key] ?? 'none') === k))]),
);
// "Local-only": a positive run counts as correct only if the right target
// was ALSO chosen without the cloud; negatives are unaffected.
const localOnly = rate(runs.map((r) => ({
  correct: r.correct && (r.expectedTargetId === null || r.mechanismIsLocal === true),
})));

const summary = {
  metric: 'visual_context_accuracy',
  definition: 'correct first-target identifications / total evaluated runs; negative cases are correct when nothing is highlighted',
  overall: rate(runs),
  localOnly,
  byCategory: groupBy('category'),
  byMechanism: groupBy('mechanism'),
  timeToFirstHighlightMs: summarize(runs.map((r) => r.timeToFirstHighlightMs)),
  moondreamLatencyMs: summarize(runs.flatMap((r) => r.visionLatencyMs)),
  qwenLatencyMs: summarize(runs.flatMap((r) => r.qwenLatencyMs)),
};

const file = writeResult('visual-accuracy', {
  generatedAt: new Date().toISOString(),
  machine: machineInfo(),
  config: { reps, timeoutMs, executionMode: 'local-qwen', cases: cases.map((c) => c.id) },
  summary,
  runs,
});
console.log(`\nVisual accuracy: ${summary.overall.correct}/${summary.overall.total}` +
  ` = ${(100 * summary.overall.accuracy).toFixed(1)}%  (local-only ${(100 * localOnly.accuracy).toFixed(1)}%)`);
console.log(`Results: ${file}`);
