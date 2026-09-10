// ScreenPilot v3 — Playground CAPTURE_SCREENSHOT Privacy Wiring Test (Phase 3)
//
// The developer playground (extension/playground/playground.js) builds its
// own CAPTURE_SCREENSHOT message independently of v2-task.js and used to send
// it with no sensitive-region info at all — the Phase 3 audit's clearest
// bypass. This is a static/structural check (playground.js is a large
// interactive debug tool with no existing test harness — driving its actual
// goal-submission UI is out of proportion to this fix) proving the message
// now carries sensitiveRegions/devicePixelRatio, computed via the same
// PageStateService mechanism v2-task.js already relies on.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.join(__dirname, '..', 'playground', 'playground.js'), 'utf8')
  .replace(/\r\n/g, '\n');

test('playground.js imports PageStateService (reuses the existing page-state/privacy mechanism)', () => {
  assert.match(source, /import\s*\{\s*PageStateService\s*\}\s*from\s*['"]\.\.\/services\/page-state-service\.js['"]/);
});

test('playground.js computes sensitiveRegions via PageStateService before requesting a screenshot', () => {
  const captureIdx = source.indexOf("type: 'CAPTURE_SCREENSHOT'");
  assert.ok(captureIdx !== -1, 'playground.js must still send a CAPTURE_SCREENSHOT message');

  // The sensitiveRegions computation must happen BEFORE the message is sent,
  // and the sendMessage call must reference the computed regions.
  const before = source.slice(Math.max(0, captureIdx - 400), captureIdx);
  assert.match(before, /PageStateService\.extractPageState\(\)/, 'sensitiveRegions must be computed from the live page state ahead of the request');

  const messageBlock = source.slice(captureIdx - 200, captureIdx + 200);
  assert.match(messageBlock, /sensitiveRegions/, 'the CAPTURE_SCREENSHOT message must include sensitiveRegions');
  assert.match(messageBlock, /devicePixelRatio/, 'the CAPTURE_SCREENSHOT message must include devicePixelRatio');
});
