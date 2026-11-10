// Phase 4 wiring — structural checks against v2-task.js's source (same
// approach as Phase 1/3's *-wiring.test.mjs: it's a whole content-script
// module with heavy browser dependencies, read directly rather than imported).
// Also re-confirms the standing V3-owned-file boundary, since Phase 4 touches
// v2-task.js and session-store.js again.

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
//   - { commit } — the file must be byte-identical to that commit's version
//                  (for a file that has NOT been intentionally extended: pin it
//                  to V3_BASE above).
//   - { blob }   — the file must be byte-identical to that exact, approved
//                  content. A blob id is used (rather than the hash of a commit
//                  that does not exist yet) so the approved version is pinned
//                  precisely and independently of when/how it is committed.
//
// Two V3 extensions have been INTENTIONALLY approved, each after review. They
// are deliberate extensions of V3, not drift:
//
//  1. CONTEXTUAL GROUNDING — ui-grounding-service.js and page-state-service.js.
//     A bounded `context` field naming the row/container a control sits in, and
//     its use in L2 scoring, so identically-labelled controls in different rows
//     can be told apart.
//
//  2. EXECUTOR IDENTITY RESOLUTION — executor-engine.js, v2-task.js and the new
//     lib/row-context.js. A step keeps the identity of the specific element the
//     planner selected (row context + its ordinal among same-labelled controls,
//     with position as corroboration), and the executor fails closed rather than
//     highlighting an arbitrary same-labelled control. v2-task.js is pinned
//     because it carries the enrichment that supplies that identity;
//     row-context.js is pinned because the executor's parity with page-state
//     extraction depends on it.
//
// No file has been unprotected: every protected file is still pinned, now to its
// approved content. Any FURTHER change to ANY file below, however small, fails
// this test until it has been reviewed and re-pinned here on purpose.
const V3_PINS = {
  // ── contextual grounding (approved) ──
  'extension/services/ui-grounding-service.js': { blob: '96a11c07fbb9486f350134fd5687b28373285c53' },
  'extension/services/page-state-service.js':   { blob: '0030b6d4a1c03a23c50724fbbafb7c9c7c6499ff' },
  // ── executor identity resolution (approved) ──
  'extension/services/executor-engine.js':      { blob: '4447bfd0654ee191ac85f7bc3ee2baa42a94ed01' },
  'extension/v2-task.js':                       { blob: '06ec6a67cf613404aebf924c4c9da68b4f6a20ed' },
  'extension/lib/row-context.js':               { blob: '9c0d33b7df9e7604cc00e53a7bda37a2dc415916' }
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

test('no V3-owned file differs from its pinned baseline (per-file V3_PINS: approved contextual-grounding and executor-identity extensions)', () => {
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

test('Phase 6: compact-page-state.js toCompactElement() IS the prompt-boundary projection in both local model adapters', () => {
  for (const f of ['extension/providers/local-qwen-adapter.js', 'extension/providers/local-vision-adapter.js']) {
    const src = read(f);
    assert.match(src, /import \{ toCompactElement \} from '\.\.\/lib\/compact-page-state\.js'/, f);
    assert.match(src, /toCompactElement\(e\)/, f);
  }
  // L1/L2 keep the rich element shape: the router itself does not compact.
  assert.equal(/compact-page-state/.test(read('extension/services/decision-router.js')), false);
});

test('v2-task.js imports task-progress.js and wires it at the planned points', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /import \{ deriveTaskProgress \}\s*\n?\s*from '\.\/lib\/task-progress\.js'/);
  // top-of-loop snapshot, right after the session-null guard
  assert.match(src, /logEvent\('task_progress_snapshot', deriveTaskProgress\(session, \{ taskState: _state \}\)\)/);
  // abort paths
  assert.match(src, /logEvent\('task_progress_snapshot', deriveTaskProgress\(await SessionStore\.load\(_tabId\), \{ aborted: true \}\)\)/);
  assert.match(src, /deriveTaskProgress\(s, \{ aborted: true \}\)/);
});

test('replanCount is incremented once per genuine replan (the fill_value_not_satisfied emit resolves "completed" and reaches the completed-path increment, so it must not add a second one)', () => {
  const src = read('extension', 'v2-task.js');
  const replanEmits = (src.match(/applyEvent\(TaskEvent\.REPLAN_TRIGGERED/g) || []).length;
  const replanIncrements = (src.match(/SessionStore\.incrementReplanCount\(tabId\)/g) || []).length;
  assert.equal(replanEmits, 3, 'expected exactly the three known REPLAN_TRIGGERED sites');
  assert.equal(replanIncrements, 2, 'element_not_found and the completed-path replan each increment replanCount exactly once');
  assert.match(src, /REPLAN_TRIGGERED, \{ reason: "fill_value_not_satisfied" \}\);\s*\n\s*done\("completed"\)/);
});

test('lastActionResult is patched exactly once, immediately after _executeStep resolves', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(
    src,
    /const result = await _executeStep\(tabId, plannerStep, freshSession\.goal, myGen\);\s*\n[\s\S]{0,400}?SessionStore\.patchSession\(tabId, \{ lastActionResult: result, lastActionAt: Date\.now\(\) \}\)/
  );
});

test('SESSION_RESUME (bootstrap/pause-resume) paths never increment replanCount — only genuine replans do', () => {
  const src = read('extension', 'v2-task.js');
  // Every SESSION_RESUME emission site must not have incrementReplanCount on
  // the same statement/line (a resume is not a replan).
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('TaskEvent.SESSION_RESUME')) {
      assert.equal(line.includes('incrementReplanCount'), false, `line ${i + 1} conflates SESSION_RESUME with a replan`);
    }
  });
});

test('Phase 1/2/3 guarantees remain in place (SanitizingAdapter, BYOK removal, compact-state diagnostics)', () => {
  const src = read('extension', 'v2-task.js');
  assert.match(src, /new SanitizingAdapter\(new VercelBackendAdapter\(\)[,)]/);
  assert.equal(/openRouterApiKey/.test(src), false);
  assert.match(src, /logEvent\('compact_state_built'/);
});

test('session-store.js additions are additive: create() still sets every pre-Phase-4 field, plus the three new ones', () => {
  const src = read('extension', 'services', 'session-store.js');
  for (const field of ['replanCount:', 'lastActionResult:', 'lastActionAt:']) {
    assert.ok(src.includes(field), `create() must initialize ${field}`);
  }
  assert.match(src, /export function maxPlannerCalls\(session\)/);
  assert.match(src, /async incrementReplanCount\(tabId\)/);
});
