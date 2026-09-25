// ScreenPilot evaluation — fixture loading. Ground truth lives in
// eval/ground-truth/*.json (manually entered); this only turns it into pages.

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './harness.mjs';

// One neutral stylesheet for every synthetic case, so visual differences
// between cases come only from each case's own markup.
const BASE_CSS = `
  body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; color: #222; }
  .row { display: flex; gap: 16px; align-items: center; margin: 16px 0; }
  .topnav { display: flex; gap: 20px; padding: 12px 0; border-bottom: 1px solid #ccc; }
  .sidebar { display: flex; flex-direction: column; gap: 10px; width: 220px; }
  input { padding: 8px; border: 1px solid #bbb; border-radius: 4px; display: block; margin: 6px 0 14px; width: 320px; }
  button { padding: 8px 16px; border: 1px solid #999; border-radius: 4px; background: #fff; cursor: pointer; }
  button.icon { width: 40px; height: 40px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  button.swatch { width: 56px; height: 56px; padding: 0; border: 2px solid #555; }
  .ghost { background: transparent; }
  .small { font-size: 12px; }
  section { margin: 18px 0; }
`;

export function fixturePage(bodyHtml, title = 'Benchmark page') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

export function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

/**
 * URL path for a case. Deliberately NEUTRAL (an index, never the case id):
 * ScreenPilot's goal verifier reads the page URL and title, so a path/title
 * like "icon-single-svg-gear" would leak benchmark words into the system
 * under test and could fake a "goal already satisfied" result.
 */
export function casePath(cases, caseId) {
  return `/page/${cases.findIndex((c) => c.id === caseId) + 1}`;
}

/** Map of URL path → full HTML for every visual case. */
export function visualCasePages(cases) {
  const pages = {};
  for (const c of cases) {
    pages[casePath(cases, c.id)] = c.htmlFile
      ? fs.readFileSync(path.join(REPO_ROOT, c.htmlFile), 'utf8')
      : fixturePage(c.html, 'Benchmark page');
  }
  return pages;
}

/** Tiny argv parser: --key value / --flag. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
