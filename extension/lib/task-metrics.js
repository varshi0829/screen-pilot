// ScreenPilot — Task Metrics (Phase 7)
//
// A pure, side-effect-free aggregator over a task's own per-cycle numbers —
// the same domMs/layer1Ms/layer2Ms/qwenMs/visionMs/cloudMs/verifyMs values
// v2-task.js already computes and console-logs every cycle (see its
// [SP:V2:PERF] lines), plus the fingerprint-optimization bookkeeping from
// page-snapshot.js/session-store.js. No new instrumentation at the source:
// this only reduces numbers that already exist into one task-level summary,
// emitted once via the existing sp-logger.js at each task-exit point.
//
// deriveTaskMetrics() takes no DOM, no network, no timers of its own — it is
// a pure function of its three arguments, matching task-progress.js's own
// convention exactly.
//
// PII/privacy: this object never carries a URL, goal text, provider output,
// or query string. `taskId` is session.sessionId (crypto.randomUUID(),
// already-existing, opaque). `outcomeReason` is drawn from a small fixed
// enum, never interpolated free text. Callers pass this straight to
// logEvent() (sp-logger.js), which redacts as a backstop regardless.

// One entry per planning-loop cycle. Fields are populated by whichever parts
// of the cycle actually ran:
//   { skipped: boolean,
//     domMs: number,                              // always known (extraction always runs)
//     layer: 'deterministic'|'ml_grounding'|'local_qwen'|'local_vision'|'cloud'|null,
//     layer1Ms, layer2Ms, qwenMs, visionMs, cloudMs: number,   // 0 when that stage didn't run
//     verifyMs: number|null,                        // post-action verify poll, only when a real user action was checked
//     verdict: 'PASSED'|'INCONCLUSIVE'|null,         // validateStep()'s own existing return value, untouched
//     outcome: string }                             // this cycle's lastCycleOutcome-equivalent tag

const ROUTER_LAYER_TO_BUCKET = Object.freeze({
  deterministic: 'deterministic',
  ml_grounding:  'mlGrounding',
  local_qwen:    'localQwen',
  local_vision:  'localVision',
  cloud:         'cloud',
});

// Cycle-outcome tags that represent a genuine replan (i.e., every routed
// cycle that did NOT resolve the task's own final completion this cycle).
// 'step_completed' here means "ordinary progression" — see the doc comment
// on the ordinaryProgression key: it excludes a task's own terminal step,
// which exits before reaching the fallthrough site that tags this outcome.
const REPLAN_OUTCOME_TO_BUCKET = Object.freeze({
  element_not_found:       'elementNotFound',
  fill_verification_failed:'fillVerificationFailed',
  dedup_repeat:            'dedupRepeat',
  stale_plan:              'stalePlan',
  retryable_error:         'retryableError',
  step_completed:          'ordinaryProgression',
});

const MODEL_LAYERS = new Set(['local_qwen', 'local_vision', 'cloud']);

function emptyLatencyBucket() {
  return { totalMs: 0, avgMs: 0, count: 0 };
}

function latencyBucket(records, field) {
  const values = [];
  for (const r of records) {
    const v = r?.[field];
    if (typeof v === 'number' && v > 0) values.push(v);
  }
  if (!values.length) return emptyLatencyBucket();
  const totalMs = values.reduce((a, b) => a + b, 0);
  return { totalMs, avgMs: Math.round(totalMs / values.length), count: values.length };
}

/**
 * @param {Array<object>} cycleRecords - one entry per planning-loop cycle, in
 *   cycle order (see the shape documented above). An empty array is valid —
 *   it happens whenever a task's completion/abort is observed in a
 *   content-script lifetime that never ran a planning cycle itself (e.g. a
 *   navigation-terminal bootstrap resume, or a stop clicked before the first
 *   cycle) — the result then honestly reports zeroed latency/layer fields
 *   rather than fabricating any.
 * @param {object|null} sessionSnapshot - the SessionStore session, loaded
 *   BEFORE it is cleared, or null if unavailable.
 * @param {object} [options]
 * @param {'complete'|'failed'|'aborted'} [options.outcome]
 * @param {string|null} [options.outcomeReason] - a small fixed enum value
 *   (see v2-task.js's exit sites), never free text.
 * @returns {object} — see the module doc comment for the PII-safety contract.
 */
export function deriveTaskMetrics(cycleRecords, sessionSnapshot, { outcome = null, outcomeReason = null } = {}) {
  const records = Array.isArray(cycleRecords) ? cycleRecords : [];
  const routedRecords = records.filter((r) => r && !r.skipped);
  const skippedRecords = records.filter((r) => r && r.skipped);

  const layerCounts = { deterministic: 0, mlGrounding: 0, localQwen: 0, localVision: 0, cloud: 0 };
  for (const r of routedRecords) {
    const bucket = ROUTER_LAYER_TO_BUCKET[r.layer];
    if (bucket) layerCounts[bucket] += 1;
  }

  const replansByOutcome = { elementNotFound: 0, fillVerificationFailed: 0, dedupRepeat: 0, stalePlan: 0, retryableError: 0, ordinaryProgression: 0 };
  for (const r of routedRecords) {
    const bucket = REPLAN_OUTCOME_TO_BUCKET[r.outcome];
    if (bucket) replansByOutcome[bucket] += 1;
  }
  // Derived as the sum of the tagged buckets (NOT read from the separate,
  // never-resetting session.replanCount) so the
  // `replans.total === sum(replans.byOutcome.*)` invariant holds by
  // construction even across a resume/bootstrap boundary, where cycleRecords
  // (page-scoped, like v2-task.js's existing _taskContext) may cover less
  // than session.replanCount's full, persisted history.
  const replansTotal = Object.values(replansByOutcome).reduce((a, b) => a + b, 0);

  const verificationOutcomes = { passed: 0, inconclusive: 0, fillNotSatisfied: 0 };
  for (const r of routedRecords) {
    if (r.verdict === 'PASSED') verificationOutcomes.passed += 1;
    else if (r.verdict === 'INCONCLUSIVE') verificationOutcomes.inconclusive += 1;
    if (r.outcome === 'fill_verification_failed') verificationOutcomes.fillNotSatisfied += 1;
  }

  // Ground truth from the session itself when available — this is what
  // actually persists across navigation/resume, unlike cycleRecords.
  const completed = Array.isArray(sessionSnapshot?.completedSteps)
    ? sessionSnapshot.completedSteps.length
    : replansByOutcome.ordinaryProgression + (outcome === 'complete' ? 1 : 0);

  // An ESTIMATE, not a guarantee (see the module's own naming) — counts a
  // skip as "avoided a model call" only when the most recently ROUTED cycle
  // before it resolved via local_qwen/local_vision/cloud, i.e. would
  // plausibly have escalated that far again given an unchanged fingerprint.
  let modelCallsAvoidedEstimate = 0;
  let lastRoutedLayer = null;
  for (const r of records) {
    if (!r) continue;
    if (r.skipped) {
      if (MODEL_LAYERS.has(lastRoutedLayer)) modelCallsAvoidedEstimate += 1;
    } else {
      lastRoutedLayer = r.layer ?? null;
    }
  }

  const startedAt = typeof sessionSnapshot?.createdAt === 'number' ? sessionSnapshot.createdAt : null;
  const endedAt = Date.now();

  return {
    schemaVersion: '1',
    taskId: sessionSnapshot?.sessionId ?? null,
    startedAt,
    endedAt,
    totalLatencyMs: startedAt != null ? endedAt - startedAt : null,

    cycles: {
      total: records.length,
      routed: routedRecords.length,
      skipped: skippedRecords.length,
    },

    layerCounts,

    layerLatencyMs: {
      stateExtraction:  latencyBucket(records, 'domMs'),
      l1:               latencyBucket(routedRecords, 'layer1Ms'),
      l2:               latencyBucket(routedRecords, 'layer2Ms'),
      localQwen:        latencyBucket(routedRecords, 'qwenMs'),
      localVision:      latencyBucket(routedRecords, 'visionMs'),
      cloud:            latencyBucket(routedRecords, 'cloudMs'),
      postActionVerify: latencyBucket(routedRecords, 'verifyMs'),
    },

    actions: {
      completed,
      verificationOutcomes,
    },

    replans: {
      total: replansTotal,
      byOutcome: replansByOutcome,
    },

    fingerprintOptimization: {
      skipsAttempted: skippedRecords.length,
      modelCallsAvoidedEstimate,
    },

    outcome,
    outcomeReason,
  };
}
