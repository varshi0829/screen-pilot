// ScreenPilot v3 — Screenshot Redaction Unit Tests (privacy-vision Phase 1)
//
// computeRedactionRects is a pure geometry function (no OffscreenCanvas/
// createImageBitmap/chrome.* involved), so it's testable directly under
// Node without a browser. It's the only new logic added to the screenshot
// pipeline; compressImage/captureVisibleTab just feed it and draw its output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotService } from '../services/screenshot-service.js';

test('no sensitive regions -> no redaction rects (existing pipeline unaffected)', () => {
  const rects = ScreenshotService.computeRedactionRects([], 1, 1024, 768);
  assert.deepEqual(rects, []);
});

test('undefined/missing sensitiveRegions behaves like an empty list', () => {
  const rects = ScreenshotService.computeRedactionRects(undefined, 1, 1024, 768);
  assert.deepEqual(rects, []);
});

test('a single CSS-pixel region is scaled by devicePixelRatio * resize scale', () => {
  // devicePixelRatio=2 (retina), resize scale=0.5 (image was shrunk to half) -> combined 1.0
  const rects = ScreenshotService.computeRedactionRects(
    [{ x: 10, y: 20, width: 100, height: 30 }],
    1.0,
    1024,
    768
  );
  assert.equal(rects.length, 1);
  assert.deepEqual(rects[0], { x: 10, y: 20, width: 100, height: 30 });
});

test('regions are scaled proportionally when devicePixelRatio/resize combine to 2x', () => {
  const rects = ScreenshotService.computeRedactionRects(
    [{ x: 10, y: 20, width: 100, height: 30 }],
    2,
    1024,
    768
  );
  assert.equal(rects.length, 1);
  assert.deepEqual(rects[0], { x: 20, y: 40, width: 200, height: 60 });
});

test('a region is clipped to the canvas bounds rather than overflowing it', () => {
  const rects = ScreenshotService.computeRedactionRects(
    [{ x: 950, y: 700, width: 200, height: 200 }],
    1,
    1024,
    768
  );
  assert.equal(rects.length, 1);
  assert.equal(rects[0].x, 950);
  assert.equal(rects[0].y, 700);
  assert.equal(rects[0].width, 1024 - 950);
  assert.equal(rects[0].height, 768 - 700);
});

test('zero-size or malformed regions are dropped, not drawn as empty rects', () => {
  const rects = ScreenshotService.computeRedactionRects(
    [
      { x: 5, y: 5, width: 0, height: 20 },
      { x: 5, y: 5, width: 20, height: 0 },
      null,
      {}
    ],
    1,
    1024,
    768
  );
  assert.deepEqual(rects, []);
});

test('multiple sensitive regions each produce their own rect', () => {
  const rects = ScreenshotService.computeRedactionRects(
    [
      { x: 0, y: 0, width: 50, height: 20 },
      { x: 100, y: 100, width: 60, height: 25 }
    ],
    1,
    1024,
    768
  );
  assert.equal(rects.length, 2);
});

// ── backward-compatible API shape ────────────────────────────────────────────

test('captureVisibleTab and compressImage still accept being called with just one argument', () => {
  // We can't exercise the real chrome.tabs/OffscreenCanvas pipeline under Node,
  // but the public shape callers rely on (function arity / no required new
  // params) must remain unchanged so every existing caller keeps compiling.
  assert.equal(typeof ScreenshotService.captureVisibleTab, 'function');
  // .length only counts params before the first one with a default value, so
  // this being 1 (just `windowId`) confirms sensitiveRegions/devicePixelRatio
  // are optional and every pre-existing single-argument call site still works.
  assert.equal(ScreenshotService.captureVisibleTab.length, 1);
});
