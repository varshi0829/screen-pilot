// ScreenPilot evaluation — builds an in-page probe from the UNMODIFIED
// production detector sources, for injection into a benchmark page:
//
//   window.__SPEval.v2 = { PageStateService, PrivacySanitizer }   (V2 agent path)
//   window.__SPEval.v1 = { getSensitiveScreenshotRegions }        (V1 content.js path)
//
// V2: esbuild-bundled straight from extension/services + extension/lib.
// V1: content.js is a classic IIFE content script, so its privacy helpers are
//     sliced out verbatim with exactly the same markers
//     extension/tests/content-privacy-context.test.mjs already uses — the
//     benchmark never re-implements either detector.

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { REPO_ROOT } from './harness.mjs';

async function buildV2Bundle() {
  const entry = `
    import { PageStateService } from ${JSON.stringify(path.join(REPO_ROOT, 'extension/services/page-state-service.js').replace(/\\/g, '/'))};
    import { PrivacySanitizer } from ${JSON.stringify(path.join(REPO_ROOT, 'extension/lib/privacy-sanitizer.js').replace(/\\/g, '/'))};
    window.__SPEval = Object.assign(window.__SPEval || {}, { v2: { PageStateService, PrivacySanitizer } });
  `;
  const out = await build({
    stdin: { contents: entry, resolveDir: REPO_ROOT, loader: 'js' },
    bundle: true, format: 'iife', write: false, logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

export function extractV1HelperSource() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'extension/content.js'), 'utf8').replace(/\r\n/g, '\n');
  const startIdx = source.indexOf('const SP_SENSITIVE_INPUT_TYPES');
  const endFnIdx = source.indexOf('function getScreenshotPrivacyContext()');
  if (startIdx === -1 || endFnIdx === -1) throw new Error('content.js privacy helper block not found');
  const closeRel = source.slice(endFnIdx).indexOf('\n  }\n');
  if (closeRel === -1) throw new Error('end of getScreenshotPrivacyContext() not found');
  return source.slice(startIdx, endFnIdx + closeRel + '\n  }\n'.length);
}

export async function buildPageProbe() {
  const v2 = await buildV2Bundle();
  const v1 = `window.__SPEval = Object.assign(window.__SPEval || {}, { v1: (function () {
${extractV1HelperSource()}
return { getSensitiveScreenshotRegions };
})() });`;
  return `${v2}\n${v1}`;
}
