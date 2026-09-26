import './_setup.mjs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
const { createRateLimiter } = await import('../../src/server/rate-limit.ts');

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('allows requests up to sessionMax, then blocks with "session"', () => {
  const c = clock();
  const rl = createRateLimiter({ sessionMax: 3, globalMax: 100, now: c.now });
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('a'), 'session');
});

test('sessions are independent', () => {
  const rl = createRateLimiter({ sessionMax: 1, globalMax: 100 });
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('b'), null);
  assert.equal(rl.check('a'), 'session');
  assert.equal(rl.check('b'), 'session');
});

test('the session window resets after windowMs', () => {
  const c = clock();
  const rl = createRateLimiter({ sessionMax: 1, globalMax: 100, windowMs: 1000, now: c.now });
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('a'), 'session');
  c.advance(1001);
  assert.equal(rl.check('a'), null);
});

test('the global limit blocks across sessions once reached, independent of the session limit', () => {
  const rl = createRateLimiter({ sessionMax: 100, globalMax: 2 });
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('b'), null);
  assert.equal(rl.check('c'), 'global');
});

test('the global window resets after windowMs', () => {
  const c = clock();
  const rl = createRateLimiter({ sessionMax: 100, globalMax: 1, windowMs: 1000, now: c.now });
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('b'), 'global');
  c.advance(1001);
  assert.equal(rl.check('c'), null);
});

test('exempt=true skips the global check but still enforces the session check', () => {
  const rl = createRateLimiter({ sessionMax: 2, globalMax: 1 });
  assert.equal(rl.check('a'), null);
  assert.equal(rl.check('b', true), null);
  assert.equal(rl.check('c', true), null, 'exempt requests never trip the global limiter');
  assert.equal(rl.check('a', true), null);
  assert.equal(rl.check('a', true), 'session', 'exempt still respects the per-session cap');
});

test('defaults match the pre-refactor hardcoded limits (100/session, 12/global)', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 12; i++) assert.equal(rl.check(`s${i}`), null, `request ${i}`);
  assert.equal(rl.check('s99'), 'global');
});

test('env vars override the defaults', () => {
  const saved = { s: process.env.RATE_LIMIT_SESSION_PER_MIN, g: process.env.RATE_LIMIT_GLOBAL_PER_MIN };
  process.env.RATE_LIMIT_SESSION_PER_MIN = '2';
  process.env.RATE_LIMIT_GLOBAL_PER_MIN = '1';
  try {
    const rl = createRateLimiter();
    assert.equal(rl.check('a'), null);
    assert.equal(rl.check('b'), 'global');
  } finally {
    if (saved.s === undefined) delete process.env.RATE_LIMIT_SESSION_PER_MIN; else process.env.RATE_LIMIT_SESSION_PER_MIN = saved.s;
    if (saved.g === undefined) delete process.env.RATE_LIMIT_GLOBAL_PER_MIN; else process.env.RATE_LIMIT_GLOBAL_PER_MIN = saved.g;
  }
});

test('two independently-created limiters never share state', () => {
  const a = createRateLimiter({ sessionMax: 100, globalMax: 1 });
  const b = createRateLimiter({ sessionMax: 100, globalMax: 1 });
  assert.equal(a.check('x'), null);
  assert.equal(b.check('x'), null, 'a second limiter instance must start fresh');
});
