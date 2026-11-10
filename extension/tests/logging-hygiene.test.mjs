// Regression guard for log hygiene: temporary diagnostics, raw model output and
// typed field values must not be logged by extension source or its bundles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'tests' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const sources = files(EXT).map((f) => [path.relative(EXT, f), fs.readFileSync(f, 'utf8')]);

test('no temporary [SP:DIAG:*] instrumentation remains (source or dist)', () => {
  const hits = sources.filter(([, s]) => /SP:DIAG/.test(s)).map(([f]) => f);
  assert.deepEqual(hits, []);
});

test('raw model output and prompt lines are never logged', () => {
  const hits = sources.filter(([, s]) => /console\.\w+\([^)]*(raw model output|compact lines sent)/.test(s)).map(([f]) => f);
  assert.deepEqual(hits, []);
});

test('the fill-completion log records length, never the typed value', () => {
  const s = fs.readFileSync(path.join(EXT, 'services/executor-engine.js'), 'utf8');
  assert.ok(!/USER_ACTION_EMITTED[^\n]*value="/.test(s));
  assert.ok(!/console\.log\("\[SP:FILL\][^\n]*\n[^\n]*value: fieldValue/.test(s));
  assert.ok(/USER_ACTION_EMITTED[^\n]*valueLen=/.test(s));
});

test('no bundle or source embeds a provider key pattern', () => {
  const re = /AIza[0-9A-Za-z_-]{30,}|sk-or-[A-Za-z0-9-]{20,}|sk-ant-[A-Za-z0-9-]{20,}/;
  assert.deepEqual(sources.filter(([, s]) => re.test(s)).map(([f]) => f), []);
});

test('state-transition log redacts event metadata (it carries the user goal)', () => {
  const s = fs.readFileSync(path.join(EXT, 'v2-task.js'), 'utf8');
  assert.ok(/Object\.entries\(meta\)[^\n]*redactText\(/.test(s));
});
