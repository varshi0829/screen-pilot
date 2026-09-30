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

// PER-FILE baselines. Each protected file must hash to exactly its pinned
// content (`git hash-object` of the working-tree file, so staged, unstaged and
// committed edits are all caught — any later modification fails):
//   - { commit } — the file must be byte-identical to that commit's version.
//   - { blob }   — the file must be byte-identical to that exact, approved
//                  content. A blob id is used (rather than the hash of a commit
//                  that does not exist yet) so the approved version is pinned
//                  precisely and independently of when/how it is committed.
//
// executor-engine.js stays pinned to the original V3 base.
//
// ui-grounding-service.js and page-state-service.js carry an INTENTIONALLY
// NEWER baseline: the approved generic contextual-grounding extension (a
// bounded `context` field naming the row/container a control sits in, and its
// use in L2 scoring, so identically-labelled controls in different rows can be
// told apart). That is a deliberate, reviewed extension of V3 — not drift. Any
// FURTHER change to either file, however small, fails this test until it is
// reviewed and re-pinned here on purpose.
const V3_PINS = {
  'extension/services/ui-grounding-service.js': { blob: '96a11c07fbb9486f350134fd5687b28373285c53' },
  'extension/services/page-state-service.js':   { blob: '0030b6d4a1c03a23c50724fbbafb7c9c7c6499ff' },
  'extension/services/executor-engine.js':      { commit: V3_BASE }
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

test('no V3-owned file differs from its pinned baseline (per-file V3_PINS; executor-engine.js pinned to V3 base c7e085f)', () => {
  const violations = [];
  for (const [file, pin] of Object.entries(V3_PINS)) {
    let expected = pin.blob;
    if (!expected) {
      try {
        expected = git('rev-parse', `${pin.commit}:${file}`);
      } catch {
        // The base ref may not exist in a shallow/CI checkout — a commit-pinned
        // check is a convenience in a full clone, not something that should fail
        // the suite when the ref simply isn't available. Blob pins never skip.
        continue;
      }
    }
    let actual;
    try {
      actual = git('hash-object', '--', file);
    } catch {
      actual = null; // a protected file that cannot be read (deleted) has been modified
    }
    if (actual !== expected) violations.push(file);
  }
  assert.deepEqual(violations, [], `V3-owned file(s) differ from their pinned baseline: ${violations.join(', ')}`);
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
