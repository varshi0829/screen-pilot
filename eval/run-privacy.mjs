// Evaluation metrics 2 & 3 — PII precision/recall and redaction precision.
//
// Detection is the UNMODIFIED production code, run in a real Chromium page:
//   V2 (agent path, used for Qwen/Moondream/cloud screenshots):
//       PageStateService.extractPageState() → element.sensitive / sensitiveRegions
//   V1 (content.js "Explain"/"Ask" screenshot path):
//       getSensitiveScreenshotRegions()
//
// Redaction is the UNMODIFIED production pipeline end to end: the regions
// each detector produced are sent through the extension's own
// CAPTURE_SCREENSHOT message → ScreenshotService.captureVisibleTab →
// compressImage (resize, black fillRect, JPEG) — i.e. the exact bytes a
// model/cloud request would receive. The harness only decodes that JPEG.
//
// Metric definitions (also written into the result file):
//   PII  : per ground-truth element, predicted = detector flagged it.
//          precision = TP/(TP+FP), recall = TP/(TP+FN), F1.
//   Redaction (pixel level, on the real output JPEG):
//          R = pixels black in the redacted capture but not in a reference
//              capture of the same page taken through the same pipeline with
//              no sensitive regions (i.e. pixels the redaction painted);
//          G = pixels inside ground-truth sensitive element boxes.
//          redaction precision = |R ∩ G| / |R|
//          sensitive coverage  = |black(redacted) ∩ G| / |G|
//          false-redaction area = |R \ G| (px and % of non-sensitive area)
//   Redaction (geometric): IoU between each ground-truth sensitive box and
//          the production redaction rectangle for it
//          (ScreenshotService.computeRedactionRects), reported per region
//          with the share of regions at IoU ≥ 0.5 and ≥ 0.9.
//
// Run:  node eval/run-privacy.mjs      (no Ollama needed)

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchExtensionBrowser, openPage, writeResult, machineInfo, RESULTS_DIR } from './lib/harness.mjs';
import { fixturePage, loadJson } from './lib/fixtures.mjs';
import { buildPageProbe } from './lib/page-probe.mjs';
import { confusion, iou, summarize } from './lib/metrics.mjs';
import { ScreenshotService } from '../extension/services/screenshot-service.js';

const BLACK_MAX_CHANNEL = 40; // JPEG-noise tolerance for "painted black"

const gt = loadJson('eval/ground-truth/privacy-fields.json');
const server = await startServer({ '/privacy': fixturePage(`<style>${gt.css}</style>${gt.html}`, 'Privacy benchmark') });
const browser = await launchExtensionBrowser({ executionMode: 'local-qwen' });

let result;
try {
  const handle = await openPage(browser, `${server.origin}/privacy`);
  await handle.page.addScriptTag({ content: await buildPageProbe() });

  // ── Detection, in the real page ─────────────────────────────────────────
  const probe = await handle.page.evaluate((gtIds) => {
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const same = (a, b) => Math.round(a.x) === b.x && Math.round(a.y) === b.y && Math.round(a.width) === b.width && Math.round(a.height) === b.height;
    const idElements = [...document.querySelectorAll('[id]')].filter((el) => !/^(sp-|screenpilot-)/.test(el.id));
    const idForBox = (box) => idElements.find((el) => same(rectOf(el), box))?.id ?? null;

    const state = window.__SPEval.v2.PageStateService.extractPageState();
    const v2Extracted = state.elements.map((e) => ({ id: e.bbox ? idForBox(e.bbox) : null, sensitive: e.sensitive === true }));
    const v1Regions = window.__SPEval.v1.getSensitiveScreenshotRegions();

    const gtBoxes = {};
    for (const id of gtIds) {
      const el = document.getElementById(id);
      const b = rectOf(el);
      gtBoxes[id] = { ...b, inViewport: b.x >= 0 && b.y >= 0 && b.x + b.width <= innerWidth && b.y + b.height <= innerHeight };
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      v2Extracted,
      v2Regions: state.sensitiveRegions,
      v2RegionIds: state.sensitiveRegions.map(idForBox),
      v1Regions,
      v1RegionIds: v1Regions.map(idForBox),
      gtBoxes,
    };
  }, Object.keys(gt.fields));

  const v2Flagged = new Set(probe.v2Extracted.filter((e) => e.sensitive && e.id).map((e) => e.id));
  const v2ExtractedIds = new Set(probe.v2Extracted.map((e) => e.id).filter(Boolean));
  const v1Flagged = new Set(probe.v1RegionIds.filter(Boolean));

  function piiReport(flagged, extractedIds) {
    const rows = Object.entries(gt.fields).map(([id, f]) => ({
      id, category: f.category, truth: f.sensitive, predicted: flagged.has(id),
      inDetectorScope: extractedIds ? extractedIds.has(id) : null,
      note: f.note ?? null,
    }));
    const byCategory = {};
    for (const r of rows) (byCategory[r.category] ??= []).push(r);
    return {
      counts: confusion(rows),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, rs]) => [k, confusion(rs)])),
      falseNegatives: rows.filter((r) => r.truth && !r.predicted).map((r) => r.id),
      falsePositives: rows.filter((r) => !r.truth && r.predicted).map((r) => r.id),
      flaggedOutsideGroundTruth: [...flagged].filter((id) => !(id in gt.fields)),
      rows,
    };
  }

  // ── Redaction, through the real extension capture pipeline ──────────────
  async function capture(regions) {
    // Chrome allows at most 2 captureVisibleTab calls/second
    // (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); pace the harness's captures.
    await handle.page.waitForTimeout(1100);
    const r = await handle.evalInExtensionWorld(
      `chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', sensitiveRegions: ${JSON.stringify(regions)}, devicePixelRatio: window.devicePixelRatio || 1 })`,
    );
    if (!r?.success) throw new Error(`CAPTURE_SCREENSHOT failed: ${r?.error}`);
    return r.image;
  }

  const sensitiveGtIds = Object.entries(gt.fields).filter(([, f]) => f.sensitive).map(([id]) => id);

  async function redactionReport(detectorRegions, detectorRegionIds, evidenceName) {
    const reference = await capture([]);
    const redacted = await capture(detectorRegions);
    // Evidence for the report/PPT: ONLY the redacted output is ever written
    // to disk. The no-region reference stays in memory for pixel diffing.
    if (evidenceName) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(RESULTS_DIR, evidenceName), Buffer.from(redacted, 'base64'));
    }

    // Decode both real JPEGs in the browser and count pixels.
    const pixels = await handle.page.evaluate(async ({ reference, redacted, viewport, sensitiveBoxes, blackMax }) => {
      const decode = async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, data: c.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const ref = await decode(reference);
      const red = await decode(redacted);
      // Ground-truth mapping CSS px → output-image px, measured from the
      // output itself (the capture spans exactly the viewport width), NOT
      // from devicePixelRatio — so it does not inherit the same assumption
      // the production mapping makes. Production's own scale is reported
      // alongside for comparison.
      const cs = red.w / viewport.width;
      const productionScale = viewport.dpr * Math.min(1, 1024 / (viewport.width * viewport.dpr));
      const toImg = (b) => ({
        x0: Math.max(0, Math.floor(b.x * cs)), y0: Math.max(0, Math.floor(b.y * cs)),
        x1: Math.min(red.w, Math.ceil((b.x + b.width) * cs)), y1: Math.min(red.h, Math.ceil((b.y + b.height) * cs)),
      });
      const inG = new Uint8Array(red.w * red.h);
      const perRegion = {};
      for (const [id, box] of Object.entries(sensitiveBoxes)) {
        const r = toImg(box);
        let px = 0, black = 0;
        for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
          const i = y * red.w + x;
          inG[i] = 1; px++;
          const o = i * 4;
          if (Math.max(red.data[o], red.data[o + 1], red.data[o + 2]) <= blackMax) black++;
        }
        perRegion[id] = { pixels: px, blackPixels: black, coverage: px ? black / px : null };
      }
      let R = 0, RinG = 0, G = 0, blackInG = 0;
      for (let i = 0; i < red.w * red.h; i++) {
        const o = i * 4;
        const bRed = Math.max(red.data[o], red.data[o + 1], red.data[o + 2]) <= blackMax;
        const bRef = Math.max(ref.data[o], ref.data[o + 1], ref.data[o + 2]) <= blackMax;
        if (inG[i]) { G++; if (bRed) blackInG++; }
        if (bRed && !bRef) { R++; if (inG[i]) RinG++; }
      }
      return {
        image: {
          width: red.w, height: red.h, sameSizeAsReference: ref.w === red.w && ref.h === red.h,
          trueCssToImageScale: cs, productionCssToImageScale: productionScale,
          productionMappingConsistent: Math.abs(cs - productionScale) / cs < 0.01,
        },
        paintedPixels: R, paintedPixelsOnSensitive: RinG, sensitivePixels: G, blackPixelsOnSensitive: blackInG,
        totalPixels: red.w * red.h, perRegion,
      };
    }, {
      reference, redacted, viewport: probe.viewport, blackMax: BLACK_MAX_CHANNEL,
      sensitiveBoxes: Object.fromEntries(sensitiveGtIds.map((id) => [id, probe.gtBoxes[id]])),
    });

    // Geometric IoU: production rectangles vs ground-truth boxes, in image px.
    // Production rectangles exactly as compressImage computes them (its own
    // scale); ground-truth boxes with the true scale measured from the image.
    const cs = pixels.image.trueCssToImageScale;
    const prodRects = ScreenshotService.computeRedactionRects(
      detectorRegions, pixels.image.productionCssToImageScale, pixels.image.width, pixels.image.height);
    const scaleBox = (b) => ({ x: b.x * cs, y: b.y * cs, width: b.width * cs, height: b.height * cs });
    const regionIou = sensitiveGtIds.map((id) => {
      const g = scaleBox(probe.gtBoxes[id]);
      const best = prodRects.reduce((m, r) => Math.max(m, iou(g, r)), 0);
      return { id, detected: detectorRegionIds.includes(id), iou: best, pixelCoverage: pixels.perRegion[id].coverage };
    });
    const detectedIous = regionIou.filter((r) => r.detected).map((r) => r.iou);
    const nonSensitivePixels = pixels.totalPixels - pixels.sensitivePixels;
    const falseRedactionPixels = pixels.paintedPixels - pixels.paintedPixelsOnSensitive;

    return {
      redactionPrecisionPixel: pixels.paintedPixels ? pixels.paintedPixelsOnSensitive / pixels.paintedPixels : null,
      sensitiveCoveragePixel: pixels.sensitivePixels ? pixels.blackPixelsOnSensitive / pixels.sensitivePixels : null,
      falseRedactionPixels,
      falseRedactionPctOfNonSensitiveArea: nonSensitivePixels ? (100 * falseRedactionPixels) / nonSensitivePixels : null,
      productionRedactionRects: prodRects.length,
      iouDetectedRegions: summarize(detectedIous),
      shareDetectedRegionsIouAtLeast50: detectedIous.length ? detectedIous.filter((v) => v >= 0.5).length / detectedIous.length : null,
      shareDetectedRegionsIouAtLeast90: detectedIous.length ? detectedIous.filter((v) => v >= 0.9).length / detectedIous.length : null,
      shareAllSensitiveRegionsIouAtLeast50: regionIou.filter((r) => r.iou >= 0.5).length / regionIou.length,
      image: pixels.image,
      pixelCounts: {
        painted: pixels.paintedPixels, paintedOnSensitive: pixels.paintedPixelsOnSensitive,
        sensitive: pixels.sensitivePixels, blackOnSensitive: pixels.blackPixelsOnSensitive, total: pixels.totalPixels,
      },
      perRegion: regionIou,
    };
  }

  const v2Redaction = await redactionReport(probe.v2Regions, probe.v2RegionIds, 'privacy-redacted-output-v2.jpg');
  const v1Redaction = await redactionReport(probe.v1Regions, probe.v1RegionIds, 'privacy-redacted-output-v1.jpg');
  await handle.close();

  result = {
    generatedAt: new Date().toISOString(),
    machine: machineInfo(),
    groundTruth: { file: 'eval/ground-truth/privacy-fields.json', definition: gt.groundTruthDefinition,
      sensitive: sensitiveGtIds.length, nonSensitive: Object.keys(gt.fields).length - sensitiveGtIds.length,
      allInViewport: Object.values(probe.gtBoxes).every((b) => b.inViewport) },
    viewport: probe.viewport,
    definitions: {
      pii: 'per ground-truth element: predicted = flagged by detector; precision=TP/(TP+FP), recall=TP/(TP+FN)',
      redactionPrecisionPixel: '|painted ∩ sensitive| / |painted|, painted = black in redacted capture and not black in a no-region reference capture (real pipeline, max channel ≤ 40)',
      sensitiveCoveragePixel: '|black(redacted) ∩ sensitive| / |sensitive|, over ALL ground-truth sensitive element boxes (so detection misses count)',
      iou: 'IoU of ground-truth sensitive box vs production redaction rect (ScreenshotService.computeRedactionRects), image px',
    },
    pii: { v2_agent_path: piiReport(v2Flagged, v2ExtractedIds), v1_content_script_path: piiReport(v1Flagged, null) },
    redaction: { v2_agent_path: v2Redaction, v1_content_script_path: v1Redaction },
  };
} finally {
  await browser.close();
  await server.close();
}

const f = writeResult('privacy', result);
const pct = (v) => (v === null ? 'n/a' : `${(100 * v).toFixed(1)}%`);
for (const [name, p] of Object.entries(result.pii)) {
  const c = p.counts;
  console.log(`PII ${name}: TP=${c.tp} FP=${c.fp} TN=${c.tn} FN=${c.fn}  precision=${pct(c.precision)} recall=${pct(c.recall)} F1=${pct(c.f1)}`);
  console.log(`   FN: ${p.falseNegatives.join(', ') || '-'}   FP: ${p.falsePositives.join(', ') || '-'}`);
}
for (const [name, r] of Object.entries(result.redaction)) {
  console.log(`Redaction ${name}: pixel precision=${pct(r.redactionPrecisionPixel)} coverage(all GT)=${pct(r.sensitiveCoveragePixel)} ` +
    `meanIoU(detected)=${r.iouDetectedRegions.mean?.toFixed(3) ?? 'n/a'} IoU≥0.5(detected)=${pct(r.shareDetectedRegionsIouAtLeast50)} ` +
    `falseRedaction=${r.falseRedactionPixels}px (${r.falseRedactionPctOfNonSensitiveArea?.toFixed(3)}%)`);
}
console.log(`Results: ${f}`);
