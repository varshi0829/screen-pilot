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
const V3_OWNED_FILES = [
  'extension/services/ui-grounding-service.js',
  'extension/services/page-state-service.js',
  'extension/services/executor-engine.js'
];

test('no V3-owned file has been modified on this branch (vs. the pinned V3 base c7e085f)', () => {
  let changed;
  try {
    // Phase 5 fix: 'v3-privacy-vision...HEAD' (three-dot, commit-to-commit)
    // is vacuous while nothing has been committed on this branch — see
    // v2-task-observability.test.mjs's identical check for the full
    // explanation. 'git diff <one-ref>' compares that commit against the
    // current working tree instead (staged + unstaged), which is correct here.
    changed = execFileSync('git', ['diff', '--name-only', V3_BASE], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    return; // ref unavailable in a shallow checkout — not a real failure
  }
  const touched = V3_OWNED_FILES.filter((f) => changed.includes(f));
  assert.deepEqual(touched, [], `V3-owned file(s) modified: ${touched.join(', ')}`);
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
