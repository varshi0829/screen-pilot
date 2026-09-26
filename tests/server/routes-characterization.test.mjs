// CHARACTERIZATION TESTS — written against the pre-refactor routes and kept
// unchanged through the refactor. They pin the externally observable contract of
// /api/plan, /api/analyze and /api/health: status codes, error bodies/codes,
// success shapes, provider selection, upstream request shape, CORS, rate limits.
//
// Deliberate Phase 2 behavior changes (BYOK removal, health `models`, analyze
// envelope, providerMetadata.provider) live in routes-changes.test.mjs instead.

import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  freshRoute, withEnv, stubFetch, captureConsole,
  openRouterOk, geminiOk, upstreamError, abortError, planBody, analyzeBody, post, keySuppliedTo, PLAN_JSON
} from './helpers.mjs';

const OR_KEY = 'test-or-key-0123456789';
const GEM_KEY = 'test-gem-key-0123456789';
const OR_MODEL = 'google/gemma-4-26b-a4b-it:free';

let con;
let net;
beforeEach(() => { con = captureConsole(); });
afterEach(() => { net?.restore(); net = undefined; con.restore(); });

const json = async (res) => res.json();

// ═════════════════════════════════════════════════════════════════════════════
// /api/plan
// ═════════════════════════════════════════════════════════════════════════════

describe('/api/plan — request handling', () => {
  test('no provider key configured → 500 SERVICE_UNAVAILABLE (FAILED envelope)', async () => {
    await withEnv({}, async () => {
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 500);
      const body = await json(res);
      assert.equal(body.schemaVersion, '1');
      assert.equal(body.result, 'FAILED');
      assert.equal(body.errorCode, 'SERVICE_UNAVAILABLE');
      assert.equal(body.error, 'Service not configured — no API key available.');
      assert.deepEqual(body.blockers, []);
      assert.equal(body.confidence, 0);
      assert.equal(body.providerMetadata.plannerVersion, '2.0');
      assert.equal(typeof body.providerMetadata.latencyMs, 'number');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });
  });

  test('invalid JSON → 400 INVALID_REQUEST', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      const { POST } = await freshRoute('plan');
      const res = await POST(post('{not json'));
      assert.equal(res.status, 400);
      const body = await json(res);
      assert.equal(body.errorCode, 'INVALID_REQUEST');
      assert.equal(body.error, 'Invalid JSON body.');
    });
  });

  for (const [label, mutate, message] of [
    ['missing goal',       (b) => { b.goal = '  '; },                       'goal is required.'],
    ['missing page.url',   (b) => { b.page.url = ''; },                     'page.url is required.'],
    ['missing screenshot', (b) => { delete b.page.screenshot; },            'page.screenshot.image is required.']
  ]) {
    test(`${label} → 400 INVALID_REQUEST "${message}"`, async () => {
      await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
        const { POST } = await freshRoute('plan');
        const body = planBody();
        mutate(body);
        const res = await POST(post(body));
        assert.equal(res.status, 400);
        const out = await json(res);
        assert.equal(out.errorCode, 'INVALID_REQUEST');
        assert.equal(out.error, message);
      });
    });
  }

  test('screenshot over 8MB → 413 SCREENSHOT_TOO_LARGE', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      const { POST } = await freshRoute('plan');
      const body = planBody();
      body.page.screenshot.image = 'A'.repeat(8 * 1024 * 1024 + 1);
      const res = await POST(post(body));
      assert.equal(res.status, 413);
      const out = await json(res);
      assert.equal(out.errorCode, 'SCREENSHOT_TOO_LARGE');
      assert.equal(out.error, 'Screenshot too large — zoom out and try again.');
    });
  });

  test('attemptCount above the server-side budget (12) → 429 BUDGET_EXCEEDED', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody({ executionHistory: { completedSteps: [], planVersion: 1, attemptCount: 13 } })));
      assert.equal(res.status, 429);
      const out = await json(res);
      assert.equal(out.errorCode, 'BUDGET_EXCEEDED');
      assert.equal(out.error, 'Planner budget exceeded for this workflow.');
    });
  });

  test('attemptCount exactly at the budget (12) is allowed', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody({ executionHistory: { completedSteps: [], planVersion: 1, attemptCount: 12 } })));
      assert.equal(res.status, 200);
    });
  });

  test('OPTIONS → 204 with the exact CORS preflight headers', async () => {
    const { OPTIONS } = await freshRoute('plan');
    const res = await OPTIONS();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    // The exact allow-headers VALUE is pinned in routes-changes.test.mjs: BYOK
    // removal (Phase 2, approved) drops "X-OpenRouter-Key" from it.
    assert.match(res.headers.get('access-control-allow-headers'), /Content-Type, X-Session-ID/);
  });
});

describe('/api/plan — provider selection and upstream request', () => {
  test('OPENROUTER_API_KEY set → OpenRouter, gemma model, bearer auth, text+image, temp 0.1, max_tokens 768', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY, GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 200);
      assert.equal(net.calls.length, 1);
      const call = net.calls[0];
      assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(call.headers.authorization, `Bearer ${OR_KEY}`);
      assert.equal(call.body.model, OR_MODEL);
      assert.equal(call.body.temperature, 0.1);
      assert.equal(call.body.max_tokens, 768);
      const parts = call.body.messages[0].content;
      assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url']);
      assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,QUJD');
      assert.match(parts[0].text, /Goal: create a repository called test/);
      assert.match(parts[0].text, /Current URL: https:\/\/github\.com\//);
    });
  });

  test('only GEMINI_API_KEY set → Gemini gemini-2.5-flash with inline image and thinking disabled', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk());
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 200);
      const call = net.calls[0];
      assert.ok(call.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'));
      assert.ok(keySuppliedTo(call, GEM_KEY), 'the Gemini key must be supplied to the upstream call');
      const parts = call.body.contents[0].parts;
      assert.match(parts[0].text, /Goal: create a repository called test/);
      assert.deepEqual(parts[1].inlineData, { mimeType: 'image/jpeg', data: 'QUJD' });
      assert.deepEqual(call.body.generationConfig, { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } });
    });
  });
});

describe('/api/plan — success response contract', () => {
  test('200 envelope: schemaVersion, requestId echo, plan with generated planId, providerMetadata, finishReason', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const b = await json(res);
      assert.equal(b.schemaVersion, '1');
      assert.equal(b.requestId, 'req-1');
      assert.equal(b.result, 'OK');
      assert.equal(b.state, 'planned');
      assert.equal(b.confidence, 0.9);
      assert.equal(b.plannerSummary, 'Use the New button.');
      assert.deepEqual(b.blockers, []);
      assert.deepEqual(b.interpretation, PLAN_JSON.interpretation);
      assert.deepEqual(b.goalCompletionCriteria, PLAN_JSON.goalCompletionCriteria);
      assert.match(b.plan.planId, /^[0-9a-f-]{36}$/);
      assert.equal(b.plan.goal, 'create a repository called test');
      assert.equal(b.plan.goalType, 'navigation');
      assert.equal(b.plan.applicationId, 'GitHub');
      assert.equal(b.plan.currentStepIndex, 0);
      assert.equal(b.plan.planVersion, 1);
      assert.equal(b.plan.confidence, 0.85);
      assert.equal(typeof b.plan.createdAt, 'number');
      assert.deepEqual(b.plan.steps, PLAN_JSON.plan.steps);
      assert.deepEqual(b.plan.goalCompletionCriteria, PLAN_JSON.goalCompletionCriteria);
      assert.equal(b.providerMetadata.model, OR_MODEL);
      assert.equal(b.providerMetadata.plannerVersion, '2.0');
      assert.equal(b.providerMetadata.inputTokens, 100);
      assert.equal(b.providerMetadata.outputTokens, 50);
      assert.equal(typeof b.providerMetadata.latencyMs, 'number');
      assert.deepEqual(b.extensions, { finishReason: 'stop' });
    });
  });

  test('markdown-fenced JSON from the model is parsed', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk('```json\n' + JSON.stringify(PLAN_JSON) + '\n```'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 200);
      assert.equal((await json(res)).result, 'OK');
    });
  });

  test('invalid enums are coerced (result→FAILED, state→ambiguous) and the plan is suppressed', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk(JSON.stringify({ ...PLAN_JSON, result: 'WEIRD', state: 'nonsense' })));
      const { POST } = await freshRoute('plan');
      const b = await json(await POST(post(planBody())));
      assert.equal(b.result, 'FAILED');
      assert.equal(b.state, 'ambiguous');
      assert.equal(b.plan, undefined);
    });
  });

  test('a non-"planned" state suppresses the plan even when the model sent one', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk(JSON.stringify({ ...PLAN_JSON, state: 'blocked', blockers: ['not logged in'] })));
      const { POST } = await freshRoute('plan');
      const b = await json(await POST(post(planBody())));
      assert.equal(b.state, 'blocked');
      assert.deepEqual(b.blockers, ['not logged in']);
      assert.equal(b.plan, undefined);
    });
  });

  for (const finish of ['content_filter', 'SAFETY', 'PROHIBITED_CONTENT']) {
    test(`finish_reason ${finish} → 422 SAFETY_BLOCK`, async () => {
      await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
        net = stubFetch(() => openRouterOk(JSON.stringify(PLAN_JSON), finish));
        const { POST } = await freshRoute('plan');
        const res = await POST(post(planBody()));
        assert.equal(res.status, 422);
        const b = await json(res);
        assert.equal(b.errorCode, 'SAFETY_BLOCK');
        assert.equal(b.error, 'Request blocked by content filters.');
      });
    });
  }

  test('empty model output → 422 SAFETY_BLOCK', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk(''));
      const { POST } = await freshRoute('plan');
      assert.equal((await POST(post(planBody()))).status, 422);
    });
  });

  test('unparseable model output → 502 PARSE_ERROR', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk('this is not json at all'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.errorCode, 'PARSE_ERROR');
      assert.equal(b.error, 'Planner returned an unparseable response.');
    });
  });
});

describe('/api/plan — upstream failures', () => {
  test('OpenRouter 500 → 502 UPSTREAM_ERROR with provider/upstreamStatus/message extras', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => upstreamError(500, 'model overloaded'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.result, 'FAILED');
      assert.equal(b.errorCode, 'UPSTREAM_ERROR');
      assert.equal(b.error, 'model overloaded');
      assert.equal(b.provider, 'openrouter');
      assert.equal(b.upstreamStatus, 500);
      assert.equal(b.message, 'model overloaded');
      assert.equal(net.calls.length, 1, 'no retry on OpenRouter');
    });
  });

  test('OpenRouter 429 (quota) → still 502 UPSTREAM_ERROR, NOT top-level 429 — only Gemini surfaces 429', async () => {
    // Pinning a real quirk of the current implementation: 429 is not in
    // FATAL_UPSTREAM_STATUS, so the OpenRouter models loop just exhausts (only
    // one model configured) and falls through to the generic 502 UPSTREAM_ERROR
    // path, with the real 429 preserved only in upstreamStatus.
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => upstreamError(429, 'rate limited'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.errorCode, 'UPSTREAM_ERROR');
      assert.equal(b.upstreamStatus, 429);
      assert.equal(net.calls.length, 1, 'no retry on OpenRouter, even for 429');
    });
  });

  test('OpenRouter 401 (fatal) → 502 UPSTREAM_ERROR', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => upstreamError(401, 'bad key'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 502);
      assert.equal((await json(res)).upstreamStatus, 401);
    });
  });

  test('OpenRouter timeout → 502 UPSTREAM_ERROR with message "timeout"', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => { throw abortError(); });
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.errorCode, 'UPSTREAM_ERROR');
      assert.equal(b.message, 'timeout');
      assert.equal(b.upstreamStatus, 0);
    });
  });

  test('Gemini 429 → 429 QUOTA_EXCEEDED, never retried', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(429, 'quota gone'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 429);
      const b = await json(res);
      assert.equal(b.errorCode, 'QUOTA_EXCEEDED');
      assert.equal(b.error, 'quota gone');
      assert.equal(b.provider, 'gemini');
      assert.equal(net.calls.length, 1);
    });
  });

  test('Gemini 401 (fatal) → 502 UPSTREAM_ERROR, not retried', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(401, 'bad key'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.errorCode, 'UPSTREAM_ERROR');
      assert.equal(b.provider, 'gemini');
      assert.equal(net.calls.length, 1);
    });
  });

  test('Gemini timeout is retried once, then → 504 TIMEOUT', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => { throw abortError(); });
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 504);
      const b = await json(res);
      assert.equal(b.errorCode, 'TIMEOUT');
      assert.equal(b.error, 'Analysis timed out — please try again.');
      assert.equal(net.calls.length, 2);
    });
  });

  test('Gemini 5xx is retried once, then → 504 TIMEOUT', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(503, 'unavailable'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 504);
      assert.equal((await json(res)).errorCode, 'TIMEOUT');
      assert.equal(net.calls.length, 2);
    });
  });

  test('Gemini recovers on the retry', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch((call, i) => (i === 0 ? upstreamError(503, 'blip') : geminiOk()));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      assert.equal(res.status, 200);
      assert.equal((await json(res)).result, 'OK');
      assert.equal(net.calls.length, 2);
    });
  });
});

describe('/api/plan — rate limiting', () => {
  test('the 13th shared-key request in a window → 429 RATE_LIMITED', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      for (let i = 1; i <= 12; i++) {
        const res = await POST(post(planBody()));
        assert.equal(res.status, 200, `request ${i}`);
      }
      const blocked = await POST(post(planBody()));
      assert.equal(blocked.status, 429);
      const b = await blocked.json();
      assert.equal(b.errorCode, 'RATE_LIMITED');
      assert.equal(b.error, 'Too many requests — please wait a moment.');
      assert.equal(net.calls.length, 12, 'a blocked request must not reach the provider');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// /api/analyze
// ═════════════════════════════════════════════════════════════════════════════

describe('/api/analyze — request handling', () => {
  test('no key → 500 {error:"Service not configured."}', async () => {
    await withEnv({}, async () => {
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 500);
      assert.deepEqual(await json(res), { error: 'Service not configured.' });
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });
  });

  test('invalid JSON → 400', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      const { POST } = await freshRoute('analyze');
      const res = await POST(post('{bad'));
      assert.equal(res.status, 400);
      assert.deepEqual(await json(res), { error: 'Invalid JSON body.' });
    });
  });

  test('missing goal → 400, missing screenshot → 400', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      const { POST } = await freshRoute('analyze');
      let res = await POST(post(analyzeBody({ goal: '   ' })));
      assert.equal(res.status, 400);
      assert.deepEqual(await json(res), { error: 'goal is required.' });
      res = await POST(post(analyzeBody({ screenshot: {} })));
      assert.equal(res.status, 400);
      assert.deepEqual(await json(res), { error: 'screenshot.image is required.' });
    });
  });

  test('screenshot over 8MB → 413', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody({ screenshot: { image: 'A'.repeat(8 * 1024 * 1024 + 1) } })));
      assert.equal(res.status, 413);
      assert.deepEqual(await json(res), { error: 'Screenshot too large. Please zoom out or reduce browser zoom level.' });
    });
  });

  test('OPTIONS → 204 with the exact CORS preflight headers', async () => {
    const { OPTIONS } = await freshRoute('analyze');
    const res = await OPTIONS();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    // See routes-changes.test.mjs for the exact post-BYOK-removal value.
    assert.match(res.headers.get('access-control-allow-headers'), /Content-Type, X-Session-ID/);
  });
});

describe('/api/analyze — upstream request and response', () => {
  test('navigate mode: Gemini 2.5 flash, goal in the prompt, image inline, temp 0.2 / 2048, thinking off', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      const text = JSON.stringify({ currentStep: 'x', instruction: 'Click "Settings"', confidence: 0.9 });
      net = stubFetch(() => geminiOk(text));
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const call = net.calls[0];
      assert.ok(call.url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'));
      assert.ok(keySuppliedTo(call, GEM_KEY));
      const parts = call.body.contents[0].parts;
      assert.match(parts[0].text, /Goal: open settings/);
      assert.match(parts[0].text, /URL: https:\/\/example\.com\//);
      assert.deepEqual(parts[1].inlineData, { mimeType: 'image/jpeg', data: 'QUJD' });
      assert.deepEqual(call.body.generationConfig, { temperature: 0.2, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } });
      // the client (vision-service) reads the first text part of the first candidate
      const body = await json(res);
      assert.equal(body.candidates[0].content.parts[0].text, text);
    });
  });

  test('ask mode uses the Q&A prompt with temp 0.3 / 512', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk('{"answer":"a","confidence":0.9,"elementHint":""}'));
      const { POST } = await freshRoute('analyze');
      await POST(post(analyzeBody({ mode: 'ask', goal: 'what is this page?' })));
      const call = net.calls[0];
      assert.match(call.body.contents[0].parts[0].text, /The user is looking at this browser screenshot and asking/);
      assert.match(call.body.contents[0].parts[0].text, /what is this page\?/);
      assert.deepEqual(call.body.generationConfig, { temperature: 0.3, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } });
    });
  });

  test('an unknown mode falls back to navigate', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk('{}'));
      const { POST } = await freshRoute('analyze');
      await POST(post(analyzeBody({ mode: 'nonsense' })));
      assert.match(net.calls[0].body.contents[0].parts[0].text, /universal browser copilot/);
    });
  });

  test('Gemini 429 → 429 {error:"Gemini API quota exceeded: …", source:"gemini"}, not retried', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(429, 'daily quota'));
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 429);
      assert.deepEqual(await json(res), { error: 'Gemini API quota exceeded: daily quota', source: 'gemini' });
      assert.equal(net.calls.length, 1);
    });
  });

  test('Gemini 500 → 502 {error:"Upstream error 500."}, NOT retried (analyze differs from plan here)', async () => {
    // Pinning a real divergence from /api/plan: analyze's loop returns
    // immediately on any non-429 non-ok status — it does NOT retry 5xx the way
    // plan's gemini-direct path does (see "Gemini 5xx is retried once" above).
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(500, 'oops'));
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 502);
      assert.deepEqual(await json(res), { error: 'Upstream error 500.' });
      assert.equal(net.calls.length, 1, 'analyze must NOT retry a 5xx');
    });
  });

  test('Gemini 401 (fatal-shaped) → 502 as well, NOT retried', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(401, 'bad key'));
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 502);
      assert.deepEqual(await json(res), { error: 'Upstream error 401.' });
      assert.equal(net.calls.length, 1);
    });
  });

  test('Gemini timeout is retried once, then → 504', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => { throw abortError(); });
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 504);
      assert.deepEqual(await json(res), { error: 'Analysis timed out — please try again.' });
      assert.equal(net.calls.length, 2);
    });
  });

  test('a non-timeout network error → 500 "Internal server error." (not retried)', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => { throw new TypeError('fetch failed'); });
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody()));
      assert.equal(res.status, 500);
      assert.deepEqual(await json(res), { error: 'Internal server error.' });
      assert.equal(net.calls.length, 1);
    });
  });
});

describe('/api/analyze — rate limiting', () => {
  test('the 13th shared-key request in a window → 429 with source "global"', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk('{}'));
      const { POST } = await freshRoute('analyze');
      for (let i = 1; i <= 12; i++) assert.equal((await POST(post(analyzeBody()))).status, 200, `request ${i}`);
      const blocked = await POST(post(analyzeBody()));
      assert.equal(blocked.status, 429);
      assert.deepEqual(await blocked.json(), { error: 'Too many requests — please wait a moment and try again.', source: 'global' });
      assert.equal(net.calls.length, 12);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// /api/health
// ═════════════════════════════════════════════════════════════════════════════

describe('/api/health', () => {
  test('reports the active provider and key presence (never the key), plus the server-side budget', async () => {
    const { GET } = await freshRoute('health');
    await withEnv({ OPENROUTER_API_KEY: OR_KEY, GEMINI_API_KEY: GEM_KEY }, async () => {
      const b = await (await GET()).json();
      assert.equal(b.status, 'ok');
      assert.equal(b.activeProvider, 'openrouter');
      assert.equal(b.openRouterKeyPresent, true);
      assert.equal(b.geminiKeyPresent, true);
      assert.equal(b.serverSideBudget, 12);
      assert.ok(Array.isArray(b.models));
      assert.equal(JSON.stringify(b).includes(OR_KEY), false);
      assert.equal(JSON.stringify(b).includes(GEM_KEY), false);
    });
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      const b = await (await GET()).json();
      assert.equal(b.activeProvider, 'gemini-direct');
      assert.equal(b.openRouterKeyPresent, false);
    });
    await withEnv({}, async () => {
      const b = await (await GET()).json();
      assert.equal(b.activeProvider, 'none');
      assert.equal(b.geminiKeyPresent, false);
    });
  });

  test('sends CORS origin header; OPTIONS → 204 GET, OPTIONS', async () => {
    const { GET, OPTIONS } = await freshRoute('health');
    assert.equal((await GET()).headers.get('access-control-allow-origin'), '*');
    const res = await OPTIONS();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  });
});
