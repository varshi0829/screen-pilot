// False-early-completion audit — Fix A regression tests.
//
// Fix B1 (a fill_form/plan-step-count heuristic in v2-task.js) was reverted:
// it was a static action/step-count correction, not a dynamic requirement
// evaluation, and was rejected in favor of investigating a requirement-based
// completion model instead (see the audit report). Only Fix A — the
// goalCompletionCriteria prompt instructions in src/app/api/plan/route.ts —
// remains from this pass. These tests verify Fix A's modified prompt text
// statically, from the actual source file; there is no deterministic
// prompt-builder unit test in this repo (the prompt is assembled inline from
// request-shaped data, not exposed as an isolated pure function), and
// asserting on live LLM output would not be deterministic.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTE_TS = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'app', 'api', 'plan', 'route.ts'),
  'utf8'
);

test('the prompt no longer tells the model to prefer a fixed two-signal target', () => {
  assert.doesNotMatch(ROUTE_TS, /Prefer two signals/i,
    'the old fixed-count instruction must be gone — it is what caused the compound-goal under-specification bug');
});

test('the prompt instructs one signal per distinct explicit requirement, scaling with goal complexity', () => {
  assert.match(ROUTE_TS, /one successSignal per requirement/i);
  assert.match(ROUTE_TS, /never treat two as a universal target/i);
});

test('the prompt\'s own worked example now demonstrates a compound, multi-signal case (not just the original two-signal shape)', () => {
  assert.match(ROUTE_TS, /FOUR explicit requirements/i);
  // The single-requirement example is preserved as a legitimate case, not removed.
  assert.match(ROUTE_TS, /ONE explicit requirement/i);
});

test('the prompt explicitly generalizes the guidance — not tied to any one site', () => {
  assert.match(ROUTE_TS, /applies identically on every site|not specific to any one application/i);
});
