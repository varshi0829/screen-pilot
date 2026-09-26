// INTENTIONAL Phase 2 behavior changes — approved and expected to differ from
// the pre-refactor baseline pinned in routes-characterization.test.mjs:
//   1. BYOK removed: X-OpenRouter-Key / X-Gemini-Key are no longer accepted,
//      and are no longer listed as allowed CORS preflight headers.
//   2. /api/health's `models` now reports the REAL configured model chain
//      (previously a stale, unrelated hardcoded string).
//   3. Error responses' providerMetadata.provider/model now reflect whichever
//      provider actually attempted/failed the request, instead of being
//      hardcoded to "openrouter"/the OpenRouter model regardless of outcome.
//   4. A server-side PII backstop redacts any raw PII that reaches the gateway
//      (belt-and-braces behind the extension's own Phase 1 sanitizer).
//   5. Raw model output and provider API keys are never written to the logs.

import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  freshRoute, withEnv, stubFetch, captureConsole,
  openRouterOk, geminiOk, upstreamError, planBody, analyzeBody, post
} from './helpers.mjs';

const OR_KEY = 'test-or-key-0123456789';
const GEM_KEY = 'test-gem-key-0123456789';
const EMAIL = 'jane.doe@example.com';

let con;
let net;
beforeEach(() => { con = captureConsole(); });
afterEach(() => { net?.restore(); net = undefined; con.restore(); });

describe('BYOK removal', () => {
  test('/api/plan: X-OpenRouter-Key is ignored — the shared key (or none) always decides', async () => {
    await withEnv({}, async () => {
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody(), { 'x-openrouter-key': 'user-supplied-key' }));
      assert.equal(res.status, 500, 'a BYOK header must NOT substitute for a missing shared key');
      assert.equal((await res.json()).errorCode, 'SERVICE_UNAVAILABLE');
    });
  });

  test('/api/plan: a BYOK header is never forwarded upstream and never bypasses the shared rate limit', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      for (let i = 1; i <= 12; i++) {
        const res = await POST(post(planBody(), { 'x-openrouter-key': 'user-key-should-be-ignored' }));
        assert.equal(res.status, 200, `request ${i}`);
      }
      const blocked = await POST(post(planBody(), { 'x-openrouter-key': 'user-key-should-be-ignored' }));
      assert.equal(blocked.status, 429, 'BYOK must no longer exempt a caller from the global limit');
      for (const call of net.calls) {
        assert.equal(call.headers.authorization, `Bearer ${OR_KEY}`, 'only the server-side shared key is ever sent upstream');
      }
    });
  });

  test('/api/analyze: X-Gemini-Key is ignored — the shared key (or none) always decides', async () => {
    await withEnv({}, async () => {
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody(), { 'x-gemini-key': 'user-supplied-key' }));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'Service not configured.' });
    });
  });

  test('/api/analyze: a BYOK header is never forwarded upstream', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk());
      const { POST } = await freshRoute('analyze');
      const res = await POST(post(analyzeBody(), { 'x-gemini-key': 'user-key-should-be-ignored' }));
      assert.equal(res.status, 200);
      assert.ok(net.calls[0].url.includes(GEM_KEY));
      assert.equal(net.calls[0].url.includes('user-key-should-be-ignored'), false);
    });
  });

  test('/api/plan preflight no longer allows X-OpenRouter-Key', async () => {
    const { OPTIONS } = await freshRoute('plan');
    const allow = (await OPTIONS()).headers.get('access-control-allow-headers');
    assert.equal(allow, 'Content-Type, X-Session-ID');
  });

  test('/api/analyze preflight no longer allows X-Gemini-Key', async () => {
    const { OPTIONS } = await freshRoute('analyze');
    const allow = (await OPTIONS()).headers.get('access-control-allow-headers');
    assert.equal(allow, 'Content-Type, X-Session-ID');
  });
});

describe('/api/health — models reflects real configuration', () => {
  test('reports the actual OpenRouter model when that is the active provider', async () => {
    const { GET } = await freshRoute('health');
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      const b = await (await GET()).json();
      assert.deepEqual(b.models, ['google/gemma-4-26b-a4b-it:free']);
    });
  });

  test('reports the actual Gemini model when that is the active provider', async () => {
    const { GET } = await freshRoute('health');
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      const b = await (await GET()).json();
      assert.deepEqual(b.models, ['gemini-2.5-flash']);
    });
  });

  test('reports an empty list when no provider is configured', async () => {
    const { GET } = await freshRoute('health');
    await withEnv({}, async () => {
      assert.deepEqual((await (await GET()).json()).models, []);
    });
  });
});

describe('error responses reflect the provider that actually failed', () => {
  test('a Gemini failure reports provider="gemini" and the real model, not the old hardcoded openrouter/gemma', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => upstreamError(401, 'bad key'));
      const { POST } = await freshRoute('plan');
      const res = await POST(post(planBody()));
      const b = await res.json();
      assert.equal(b.providerMetadata.provider, 'gemini');
      assert.equal(b.providerMetadata.model, 'gemini-2.5-flash');
      assert.equal(b.provider, 'gemini');
    });
  });

  test('an OpenRouter failure reports provider="openrouter" and the real model', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => upstreamError(500, 'down'));
      const { POST } = await freshRoute('plan');
      const b = await (await POST(post(planBody()))).json();
      assert.equal(b.providerMetadata.provider, 'openrouter');
      assert.equal(b.providerMetadata.model, 'google/gemma-4-26b-a4b-it:free');
    });
  });

  test('SERVICE_UNAVAILABLE (no key at all) reports provider="none"', async () => {
    await withEnv({}, async () => {
      const { POST } = await freshRoute('plan');
      const b = await (await POST(post(planBody()))).json();
      assert.equal(b.providerMetadata.provider, 'none');
    });
  });
});

describe('server-side PII backstop', () => {
  test('/api/plan: a raw email in the goal is redacted before reaching the provider', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      await POST(post(planBody({ goal: `email this to ${EMAIL}` })));
      const wire = JSON.stringify(net.calls[0].body);
      assert.equal(wire.includes(EMAIL), false);
      assert.match(wire, /\[REDACTED\]/);
    });
  });

  test('/api/plan: a clean request is unaffected (no backstop event, unchanged prompt)', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      await POST(post(planBody({ goal: 'search wikipedia for cats' })));
      const text = net.calls[0].body.messages[0].content[0].text;
      assert.match(text, /Goal: search wikipedia for cats/);
      assert.equal(con.lines.some((l) => l.includes('server_pii_backstop')), false);
    });
  });

  test('/api/plan: the backstop redaction is logged as types/counts only, never the value', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      await POST(post(planBody({ goal: `contact ${EMAIL}` })));
      const backstopLine = con.lines.find((l) => l.includes('server_pii_backstop'));
      assert.ok(backstopLine);
      assert.equal(backstopLine.includes(EMAIL), false);
      const evt = JSON.parse(backstopLine);
      assert.ok(evt.types.email >= 1);
    });
  });

  test('/api/analyze: a raw email in the goal is redacted before reaching the provider', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk());
      const { POST } = await freshRoute('analyze');
      await POST(post(analyzeBody({ goal: `is this from ${EMAIL}?` })));
      const wire = JSON.stringify(net.calls[0].body);
      assert.equal(wire.includes(EMAIL), false);
    });
  });

  test('the screenshot is never touched by the backstop', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      const body = planBody();
      const originalImage = body.page.screenshot.image;
      await POST(post(body));
      assert.equal(net.calls[0].body.messages[0].content[1].image_url.url, `data:image/jpeg;base64,${originalImage}`);
    });
  });
});

describe('nothing sensitive is ever written to the logs', () => {
  test('/api/plan: the provider API key never appears in any log line', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk());
      const { POST } = await freshRoute('plan');
      await POST(post(planBody()));
      assert.equal(con.lines.some((l) => l.includes(OR_KEY)), false);
    });
  });

  test('/api/analyze: the provider API key never appears in any log line', async () => {
    await withEnv({ GEMINI_API_KEY: GEM_KEY }, async () => {
      net = stubFetch(() => geminiOk());
      const { POST } = await freshRoute('analyze');
      await POST(post(analyzeBody()));
      assert.equal(con.lines.some((l) => l.includes(GEM_KEY)), false);
    });
  });

  test('/api/plan: raw model output text never appears in any log line', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      const distinctiveText = 'UNIQUE_MARKER_9f81c2 click the New button';
      net = stubFetch(() => openRouterOk(JSON.stringify({
        result: 'OK', state: 'planned', confidence: 0.9, plannerSummary: distinctiveText,
        plan: { goalType: 'navigation', confidence: 0.9, steps: [] }
      })));
      const { POST } = await freshRoute('plan');
      await POST(post(planBody()));
      // plannerSummary legitimately appears in the HTTP response body (contract,
      // unchanged) — the assertion here is specifically about the SERVER LOGS.
      assert.equal(con.lines.some((l) => l.includes(distinctiveText)), false);
    });
  });

  test('/api/plan: a parse failure logs length/parsedOk, never the unparseable raw text', async () => {
    await withEnv({ OPENROUTER_API_KEY: OR_KEY }, async () => {
      net = stubFetch(() => openRouterOk('not json at all, definitely unique 9f81c2'));
      const { POST } = await freshRoute('plan');
      await POST(post(planBody()));
      assert.equal(con.lines.some((l) => l.includes('9f81c2')), false);
      const outcomeLine = con.lines.find((l) => l.includes('plan_parse_failed'));
      assert.ok(outcomeLine);
      assert.match(outcomeLine, /"parsedOk":false/);
    });
  });
});
