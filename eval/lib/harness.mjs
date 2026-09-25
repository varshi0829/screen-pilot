// ScreenPilot evaluation — real-browser harness.
//
// Loads the REAL unpacked extension (extension/) into Playwright's bundled
// Chromium and drives it exactly as a user would: a goal is submitted through
// the same _startNewTask entry point the overlay's Start button calls
// (window.__SP_V2_RUN, which lives in the extension's content-script isolated
// world), the extension plans/highlights on its own, and the harness plays
// the user by clicking/typing on whatever the extension highlighted.
//
// Nothing here modifies or instruments the extension. All measurements come
// from (a) what the extension already logs to the page console and (b) what
// it actually renders (its highlight ring) or returns (its redacted JPEG).
//
// Headed on purpose: chrome.tabs.captureVisibleTab needs a real compositor
// surface ("image readback failed" in headless), and the vision/cloud paths
// and the redaction benchmark both depend on that real capture.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXT_DIR = path.join(REPO_ROOT, 'extension');
export const RESULTS_DIR = path.join(REPO_ROOT, 'eval', 'results');

const HIGHLIGHT_RING_ID = 'screenpilot-highlight'; // rendered by content.js Highlighter.show()
const HIGHLIGHT_RING_PAD = 5;                      // Highlighter's own PAD around the target rect

/**
 * Tiny static server. `pages` maps a URL path to an HTML string; anything
 * else is a 404. Serving over http (not file://) matches how the extension
 * runs on real sites and needs no "allow file URLs" toggle.
 */
export async function startServer(pages) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const html = pages[url.pathname];
    if (html == null) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Launch Chromium with the unpacked extension; set ScreenPilot's execution mode. */
export async function launchExtensionBrowser({ executionMode = 'local-qwen' } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-eval-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    // NO viewport / deviceScaleFactor emulation: with emulation the page's
    // window.devicePixelRatio (which ScreenPilot uses to map CSS boxes onto
    // the screenshot) stops matching the scale chrome.tabs.captureVisibleTab
    // really captures at (the OS display scale), which misplaces redaction
    // boxes in a way that never happens in a user's real Chrome. The window
    // therefore behaves exactly like a normal Chrome window on this machine.
    viewport: null,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--window-size=1280,800'],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  // The same storage key/area v2-task.js reads (session-store getStorageArea).
  await sw.evaluate((mode) => chrome.storage.local.set({ executionMode: mode }), executionMode);
  return {
    context,
    serviceWorker: sw,
    executionMode,
    async close() {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Open a page with console capture and a handle on the extension's isolated
 * world. Resolves once the V2 content script has bootstrapped (its own
 * "[SP:V2] Tab ID:" log), so a task can be started immediately.
 */
export async function openPage(browser, url) {
  const page = await browser.context.newPage();
  const logs = []; // {t: epoch ms when received, text}
  page.on('console', (m) => logs.push({ t: Date.now(), text: m.text() }));

  const cdp = await browser.context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
  await cdp.send('Runtime.enable');
  await page.goto(url, { waitUntil: 'load' });

  const deadline = Date.now() + 15_000;
  let world = null;
  while (Date.now() < deadline) {
    world =worlds.filter((c) => c.auxData?.type === 'isolated' && c.name === 'ScreenPilot').pop() ?? null;
    if (world && logs.some((l) => l.text.startsWith('[SP:V2] Tab ID:'))) break;
    await page.waitForTimeout(100);
  }
  if (!world) throw new Error('ScreenPilot content-script world not found — is the extension built (npm run build:ext)?');

  async function evalInExtensionWorld(expression) {
    // A navigation creates a fresh content-script world; always use the latest.
    const latest = worlds.filter((c) => c.auxData?.type === 'isolated' && c.name === 'ScreenPilot').pop() ?? world;
    const r = await cdp.send('Runtime.evaluate', { contextId: latest.id, expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  return { page, logs, evalInExtensionWorld, close: () => page.close() };
}

/**
 * Identify which page element the extension highlighted, from what it
 * actually rendered. The #screenpilot-highlight ring is drawn at the
 * highlighted element's own bounding rect plus a fixed pad, so:
 *   1. highlighted element = among the page elements under the ring's
 *      centre (ScreenPilot's own UI excluded), the one whose box best
 *      matches the ring (IoU) — this can be a descendant of a control, e.g.
 *      the <svg> inside an icon button;
 *   2. target id = that element, or its nearest ancestor with an id
 *      (benchmark fixtures give every control an id). A highlighted
 *      descendant therefore counts as its control — clicking it activates
 *      the control — while a highlighted wrapper/container does NOT map
 *      down to a control inside it.
 * Runs in the page's main world.
 */
async function readHighlightedTarget(page) {
  return page.evaluate(({ ringId, pad }) => {
    const ring = document.getElementById(ringId);
    if (!ring) return null;
    const r = ring.getBoundingClientRect();
    const target = { x: r.x + pad, y: r.y + pad, width: r.width - 2 * pad, height: r.height - 2 * pad };
    const iou = (a, b) => {
      const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
      if (x2 <= x1 || y2 <= y1) return 0;
      const inter = (x2 - x1) * (y2 - y1);
      return inter / (a.width * a.height + b.width * b.height - inter);
    };
    const isOwnUi = (el) => /^(sp-|screenpilot-)/.test(el.id || '') || !!el.closest?.('#screenpilot-widget,[data-screenpilot],[id^="screenpilot-"],[id^="sp-"]');
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;
    let highlighted = null;
    let bestIou = 0;
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (isOwnUi(el) || el === document.documentElement) continue;
      const b = el.getBoundingClientRect();
      const s = iou(target, { x: b.x, y: b.y, width: b.width, height: b.height });
      if (s > bestIou) { bestIou = s; highlighted = el; }
    }
    if (!highlighted || bestIou < 0.5) return { ringRect: target, match: null, bestIou };
    let owner = highlighted;
    while (owner && !(owner.id && !isOwnUi(owner))) owner = owner.parentElement;
    return {
      ringRect: target,
      bestIou,
      highlightedTag: highlighted.tagName.toLowerCase(),
      match: owner ? { id: owner.id, tag: owner.tagName.toLowerCase(), relation: owner === highlighted ? 'self' : 'descendant' } : null,
    };
  }, { ringId: HIGHLIGHT_RING_ID, pad: HIGHLIGHT_RING_PAD });
}

/** The id attribute from the executor's own "[SP:Exec] Candidate …" line preceding a successful highlight. */
function executorLoggedTargetId(lines) {
  let lastCandidateId = null;
  let accepted = null;
  for (const line of lines) {
    const c = /\[SP:Exec\] Candidate \d+\/\d+ score=\S+ <[^>]*> id="([^"]*)"/.exec(line);
    if (c) lastCandidateId = c[1] || null;
    if (line.includes('highlighter.show() → true')) accepted = lastCandidateId;
  }
  return accepted;
}

const TERMINAL_STATES = new Set(['COMPLETE', 'ERROR', 'PAUSED']);

/**
 * Submit `goal` and follow the task until it ends.
 *
 * `simulateUser(highlight, step)` is called each time the extension shows a
 * NEW highlight (one per ELEMENT_READY). It performs the simulated user's
 * action and returns true, or returns false to stop the task there (used by
 * the accuracy benchmark, which only needs the first pick).
 *
 * Ends on: a terminal STATE (COMPLETE / ERROR / PAUSED), simulateUser
 * returning false, or `timeoutMs`.
 */
export async function runGoal(handle, goal, { simulateUser, timeoutMs = 120_000 } = {}) {
  const { page, logs } = handle;
  const firstLog = logs.length;
  const startedAt = Date.now();
  await handle.evalInExtensionWorld(`window.__SP_V2_RUN(${JSON.stringify(goal)}); true`);

  const lines = () => logs.slice(firstLog).map((l) => l.text);
  const highlights = [];
  let handledReady = 0;
  let stopReason = null;

  while (Date.now() - startedAt < timeoutMs) {
    const current = lines();
    const readyCount = current.filter((l) => /STATE \S+ → AWAITING_USER\s+event=ELEMENT_READY/.test(l)).length;
    const lastState = [...current].reverse().find((l) => /\] STATE \S+ → \S+/.test(l));
    const terminal = lastState && TERMINAL_STATES.has(/→ (\S+)/.exec(lastState)[1]);

    if (readyCount > handledReady) {
      // A navigation (e.g. a form submit) can destroy the page's execution
      // context mid-read; just retry on the next tick.
      const seen = await readHighlightedTarget(page).catch(() => undefined);
      if (seen === undefined) { await page.waitForTimeout(50); continue; }
      handledReady = readyCount;
      const highlight = {
        atMs: Date.now() - startedAt,
        targetId: seen?.match?.id ?? null,
        targetTag: seen?.match?.tag ?? null,
        highlightedTag: seen?.highlightedTag ?? null,
        relation: seen?.match?.relation ?? null, // 'self' | 'descendant' (e.g. the icon inside a button)
        ringRect: seen?.ringRect ?? null,
        ringIou: seen?.bestIou ?? 0,
        executorLoggedId: executorLoggedTargetId(current),
      };
      highlights.push(highlight);
      const keepGoing = simulateUser ? await simulateUser(highlight, highlights.length) : false;
      if (!keepGoing) { stopReason = 'stopped_after_highlight'; break; }
    } else if (terminal) {
      stopReason = 'terminal_state';
      break;
    }
    await page.waitForTimeout(50);
  }
  if (!stopReason) stopReason = 'timeout';

  // Always leave the tab idle for the next run.
  if (stopReason !== 'terminal_state') {
    await handle.evalInExtensionWorld('window.__SP_V2_ABORT && window.__SP_V2_ABORT(); true').catch(() => {});
  }
  return {
    goal, stopReason, startedAt, wallMs: Date.now() - startedAt, highlights,
    lines: lines(),
    entries: logs.slice(firstLog), // {t: epoch ms received, text} — used to window resource samples
  };
}

/**
 * Wall-clock windows (epoch ms) during which a local model inference was in
 * flight, from the router's own start line and the adapter's own latency line.
 */
export function inferenceWindows(entries) {
  const windows = { qwen: [], moondream: [] };
  let open = { qwen: null, moondream: null };
  for (const { t, text } of entries) {
    if (text.includes('[SP:DecisionRouter] Layer 3 router=qwen')) open.qwen = t;
    if (text.includes('[SP:DecisionRouter] Layer 3 router=vision')) open.moondream = t;
    if (text.includes('[SP:V2:PERF] qwenLatencyMs=') && open.qwen != null) { windows.qwen.push({ start: open.qwen, end: t }); open.qwen = null; }
    if (text.includes('[SP:V2:PERF] visionLatencyMs=') && open.moondream != null) { windows.moondream.push({ start: open.moondream, end: t }); open.moondream = null; }
  }
  return windows;
}

/**
 * Real user-level input on what ScreenPilot highlighted: a mouse click at the
 * centre of the highlighted element (exactly where a user would click), then
 * keyboard typing for a fill.
 */
export async function actOn(page, highlight, action) {
  const r = highlight.ringRect;
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  if (action?.type === 'fill') await page.keyboard.type(action.value, { delay: 20 });
}

/** Ollama's own report of loaded models (size, size_vram → CPU vs GPU). */
export async function ollamaPs() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/ps');
    return (await r.json()).models ?? [];
  } catch {
    return null;
  }
}

export function writeResult(name, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function machineInfo() {
  return {
    cpu: os.cpus()[0]?.model?.trim(),
    logicalCores: os.cpus().length,
    totalRamGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
}
