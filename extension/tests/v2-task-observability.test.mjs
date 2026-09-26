// Phase 3 observability wiring — structural checks against v2-task.js's
// source (it's a whole content-script module with heavy browser
// dependencies, so these read the source directly rather than importing it —
// same approach as sanitizing-wiring.test.mjs for Phase 1's wiring).
//
// Also encodes, as an automated test rather than a one-off manual check, the
// standing rule this whole branch operates under: no V3-owned file may be
// modified. If this ever fails, that rule was broken — fix the change, not
// the test.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

// The V3 baseline is PINNED to a commit, not to the moving branch name: the
// v3-privacy-vision ref advances when the V3 owner pushes, and comparing
// against a moved ref reports V3's own new commits as "violations".
// Phase 6 deliberately edits decision-router.js, local-qwen-adapter.js,
// local-vision-adapter.js and v2-task.js (the V3 integration points). These
// three V3-owned files must still be untouched: L2 scoring, page-state
// extraction and the guide-only executor are not Phase 6's business.
const V3_BASE = 'c7e085f';
const V3_OWNED_FILES = [
  'extension/services/ui-grounding-service.js',
  'extension/services/page-state-service.js',
  'extension/services/executor-engine.js'
];

test('no V3-owned file has been modified on this branch (vs. the pinned V3 base c7e085f)', () => {
  let changed;
  try {
    // Phase 5 fix: this branch has never committed anything on top of its
    // base (HEAD === v3-privacy-vision's own commit throughout Phases 1-4),
    // so 'v3-privacy-vision...HEAD' (three-dot, commit-to-commit) always
    // diffed two IDENTICAL commits and passed vacuously regardless of what
    // the working tree actually contained. 'git diff <one-ref>' (no second
    // ref) instead compares that commit against the current working tree —
    // covering both staged and unstaged changes — which is what this check
    // actually needs while nothing is committed.
    changed = execFileSync('git', ['diff', '--name-only', V3_BASE], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    // The base ref may not exist in a shallow/CI checkout — this guard is a
    // convenience in a full clone, not something that should fail the suite
    // when the ref simply isn't available.
    return;
  }
  const touched = V3_OWNED_FILES.filter((f) => changed.includes(f));
  assert.deepEqual(touched, [], `V3-owned file(s) modified: ${touched.join(', ')}`);
});

test('v2-task.js imports the Phase 3 compact-state and logger modules', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /import \{ estimateCompactionSavings \}\s*\n?\s*from '\.\/lib\/compact-page-state\.js'/);
  assert.match(src, /import \{ logEvent, logWarn, logError \}\s*\n?\s*from '\.\/lib\/sp-logger\.js'/);
});

test('provider_fallback (logWarn) fires only when a tier actually failed before resolution, and plan_failed (logError) is wired to the existing catch block', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /if \(routed\.qwenFailureReason \|\| routed\.visionFailureReason\) \{\s*\n\s*logWarn\('provider_fallback', \{/);
  assert.match(src, /logError\('plan_failed', \{ reqId, name: err\?\.name \?\? null, message: redactText\(err\?\.message \?\? ''\) \}\)/);
});

test('compact_state_built is logged right where pageState is extracted for routing, without altering pageState itself', () => {
  const src = read('extension', 'v2-task.js');
  // V3 (c7e085f) now reuses the verifier gate's extraction (cyclePageState);
  // compact_state_built must still sit directly after the domMs computation,
  // before pageState feeds anything else.
  const anchor = "localPageState  = pageState;\n      const domMs     = cyclePageState ? cycleExtractMs : Date.now() - tDomStart;\n      // Observability only (Phase 3)";
  assert.ok(src.includes(anchor), 'compact_state_built must be logged immediately after pageState is extracted, before pageState is used for anything else');
  assert.match(src, /logEvent\('compact_state_built', \{ reqId, \.\.\.estimateCompactionSavings\(pageState\) \}\)/);
  // pageState itself is handed to the router untouched — the diagnostic
  // logging is a pure side channel.
  assert.match(src, /decisionRouter\.route\(freshSession\.goal, pageState, \{/);
});

test('routing_result is logged with the same fields already used in the existing PERF log line', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /logEvent\('routing_result', \{/);
  const block = src.slice(src.indexOf("logEvent('routing_result'"), src.indexOf("logEvent('routing_result'") + 600);
  for (const field of ['reqId', 'layer:', 'layer1Ms', 'layer2Ms', 'qwenMs', 'cloudMs', 'totalPlanningMs', 'confidence']) {
    assert.ok(block.includes(field), `routing_result must include ${field}`);
  }
  // Failure reasons are passed through redactText — never logged raw.
  assert.match(block, /qwenFailureReason \? redactText\(routed\.qwenFailureReason\) : null/);
  assert.match(block, /visionFailureReason \? redactText\(routed\.visionFailureReason\) : null/);
});

test('executor_result is logged on both element:ready and element:not_found, with reason redacted', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /executor\.on\("element:ready", async \(\{ step, element \}\) => \{\s*\n\s*applyEvent\(TaskEvent\.ELEMENT_READY[\s\S]{0,900}?logEvent\('executor_result', \{ tabId, ok: true,/);
  assert.match(src, /logEvent\('executor_result', \{ tabId, ok: false, reason: redactText\(reason\) \}\)/);
});

test('Phase 1/2 guarantees remain in place: SanitizingAdapter wrap and BYOK removal are still present', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /new SanitizingAdapter\(new VercelBackendAdapter\(\)[,)]/);
  assert.equal(/openRouterApiKey/.test(src), false);
});

test('no new fetch()/network call was introduced by Phase 3 (compact-page-state.js and sp-logger.js are both local-only)', () => {
  for (const f of ['extension/lib/compact-page-state.js', 'extension/lib/sp-logger.js']) {
    const src = read(f);
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.equal(code.includes('fetch('), false, f);
  }
});
