// ScreenPilot evaluation — pure metric helpers (no browser, no I/O).
//
// Everything here is deterministic arithmetic over data the harness has
// already collected, so it is unit-tested directly (eval/tests/).

/** mean/median/min/max/n over finite numbers; nulls when empty. */
export function summarize(values) {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!xs.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean, median, min: xs[0], max: xs[xs.length - 1] };
}

/** Area of a {x,y,width,height} box (0 for missing/degenerate). */
export function area(b) {
  return b && b.width > 0 && b.height > 0 ? b.width * b.height : 0;
}

/** Intersection box of two {x,y,width,height} boxes, or null. */
export function intersect(a, b) {
  if (!a || !b) return null;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

/** Intersection-over-union of two boxes, in [0,1]. */
export function iou(a, b) {
  const inter = area(intersect(a, b));
  if (!inter) return 0;
  return inter / (area(a) + area(b) - inter);
}

/**
 * Binary-classification counts + derived rates. Undefined ratios (0/0) are
 * reported as null, never silently as 0 or 1.
 *
 * @param {{truth:boolean, predicted:boolean}[]} rows
 */
export function confusion(rows) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { truth, predicted } of rows) {
    if (truth && predicted) tp++;
    else if (!truth && predicted) fp++;
    else if (!truth && !predicted) tn++;
    else fn++;
  }
  const ratio = (a, b) => (b > 0 ? a / b : null);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return { tp, fp, tn, fn, precision, recall, f1, accuracy: ratio(tp + tn, rows.length) };
}

// ── Console-log timeline parsing ────────────────────────────────────────────
//
// Every input below is a log line ScreenPilot ALREADY emits in production
// (v2-task.js applyEvent's ISO-timestamped STATE lines, the [SP:V2:PERF]
// lines, and DecisionRouter's per-layer decision lines). The harness adds no
// instrumentation to the extension; it only reads what is already printed.

const STATE_RE = /^\[SP:V2\] \[([^\]]+)\] STATE (\S+) → (\S+)\s+event=(\S+)/;

/** Parse STATE transition lines into {t, from, to, event} (t = epoch ms). */
export function parseStateEvents(lines) {
  const out = [];
  for (const line of lines) {
    const m = STATE_RE.exec(line);
    if (m) out.push({ t: Date.parse(m[1]), from: m[2], to: m[3], event: m[4] });
  }
  return out;
}

// Which mechanism produced a planning decision, from the router's own line.
// Order matters only in that each line maps to exactly one mechanism.
const DECISION_PATTERNS = [
  ['L1_deterministic',    /\[SP:DecisionRouter\] Layer 1 FAST PATH matched/],
  ['L1_required_field',   /\[SP:DecisionRouter\] Layer 1 target's form has an unmet required field/],
  ['L2_grounding',        /\[SP:DecisionRouter\] Layer 2 ML GROUNDING matched/],
  ['L2_required_field',   /\[SP:DecisionRouter\] Layer 2 target's form has an unmet required field/],
  ['qwen',                /\[SP:DecisionRouter\] Layer 3 LOCAL QWEN succeeded/],
  ['moondream',           /\[SP:DecisionRouter\] Layer 3 LOCAL VISION succeeded/],
  ['structural_fallback', /\[SP:DecisionRouter\] Layer 3 sole unlabeled interactive candidate resolved structurally/],
  ['cloud',               /\[SP:DecisionRouter\] Layer 3 CLOUD resolved/],
];

export const LOCAL_MECHANISMS = new Set([
  'L1_deterministic', 'L1_required_field', 'L2_grounding', 'L2_required_field',
  'qwen', 'moondream', 'structural_fallback',
]);

/** Ordered list of decision mechanisms seen in the log lines. */
export function parseDecisions(lines) {
  const out = [];
  for (const line of lines) {
    for (const [mechanism, re] of DECISION_PATTERNS) {
      if (re.test(line)) { out.push(mechanism); break; }
    }
  }
  return out;
}

function allInts(lines, re) {
  const out = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** Model/planning timings already printed by the extension. */
export function parsePerf(lines) {
  return {
    visionLatencyMs:  allInts(lines, /\[SP:V2:PERF\] visionLatencyMs=(\d+)/),
    qwenLatencyMs:    allInts(lines, /\[SP:V2:PERF\] qwenLatencyMs=(\d+)/),
    totalPlanningMs:  allInts(lines, /\[SP:V2:PERF\] domMs=\d+ .*totalPlanningMs=(\d+)/),
    screenshotMs:     allInts(lines, /\[SP:V2:PERF\] domMs=\d+ .*screenshotMs=(\d+)/),
    postActionVerifyMs: allInts(lines, /\[SP:V2:PERF\] stage=post_action_verify postActionVerifyMs=(\d+)/),
    visionFailures:   lines.filter((l) => /Layer 3 LOCAL VISION (named an unknown|resolved FAILED|threw|unavailable)/.test(l)).length,
    qwenFailures:     lines.filter((l) => /Layer 3 LOCAL QWEN (resolved FAILED|threw|unavailable)/.test(l)).length,
  };
}

/**
 * Split one task's STATE timeline into phases. Each phase is the sum of the
 * wall-clock time spent in the named task state(s), derived from consecutive
 * transition timestamps:
 *   planning     = time in PLANNING (goal/replan → plan received)
 *   highlight    = time in EXECUTING (plan received → element highlighted)
 *   userAction   = time in AWAITING_USER (highlight shown → user acted) —
 *                  in this harness the "user" is the simulated Playwright
 *                  click/typing, so it is reported separately, never hidden
 *   verification = time in VALIDATING
 *   total        = GOAL_SUBMITTED → first terminal transition
 *   system       = total − userAction
 */
export function phaseBreakdown(events) {
  const start = events.find((e) => e.event === 'GOAL_SUBMITTED');
  if (!start) return null;
  const terminal = events.find((e) => ['COMPLETE', 'ERROR', 'PAUSED'].includes(e.to) && e.t >= start.t);
  const end = terminal ?? events[events.length - 1];
  const phase = { PLANNING: 0, EXECUTING: 0, AWAITING_USER: 0, VALIDATING: 0, OTHER: 0 };
  const seq = events.filter((e) => e.t >= start.t && e.t <= end.t);
  for (let i = 0; i < seq.length - 1; i++) {
    const dt = seq[i + 1].t - seq[i].t;
    const state = seq[i].to;
    phase[state in phase ? state : 'OTHER'] += dt;
  }
  const total = end.t - start.t;
  return {
    outcome: terminal ? terminal.to : 'INCOMPLETE',
    totalMs: total,
    planningMs: phase.PLANNING,
    highlightMs: phase.EXECUTING,
    userActionMs: phase.AWAITING_USER,
    verificationMs: phase.VALIDATING,
    otherMs: phase.OTHER,
    systemMs: total - phase.AWAITING_USER,
    cycles: seq.filter((e) => e.to === 'PLANNING').length,
  };
}
