// ScreenPilot — Sanitizing Adapter (decorator)
//
// Wraps any BackendAdapter that talks to an EXTERNAL model (today: the Vercel
// cloud backend) so that nothing sensitive can leave the device through it:
//
//   request  →  sanitizeDeep()  →  inner adapter  →  response  →  restoreDeep()
//
// • Outgoing: every string in the request (goal, URL/title, execution history,
//   clarifications, page controls, elements, recovery context, …) is scanned by
//   the deterministic detector. Email/phone become reversible per-task
//   placeholders ([EMAIL_1]); passwords, cards, JWTs, API keys and other
//   secrets become [REDACTED] and can never be restored. The base64 screenshot
//   is passed through untouched (its regions are masked by ScreenshotService
//   from the DOM bounding boxes before it ever reaches here).
// • Incoming: placeholders in the model's answer are turned back into the
//   user's real values, in memory, for local display and DOM matching only.
//
// It is generic on purpose: it walks whatever the request contains, so new
// request fields are covered without editing this file. It never mutates the
// caller's request, never logs a value (events carry types and counts only),
// and FAILS CLOSED — if sanitization throws, the request is not sent.

import { BackendAdapter } from './interface.js';
import { TokenVault, sanitizeDeep, restoreDeep } from '../lib/pii-vault.js';

function defaultOnEvent(evt) {
  console.log(`[SP:PII] ${JSON.stringify(evt)}`);
}

export class SanitizingAdapter extends BackendAdapter {
  /**
   * @param {BackendAdapter} inner
   * @param {object} [options]
   * @param {TokenVault} [options.vault]   - per-task vault; a fresh in-memory one by default
   * @param {(evt: object) => void} [options.onEvent] - receives PII-free events ({event, method, types:{type:count}, placeholders})
   */
  constructor(inner, { vault = new TokenVault(), onEvent = defaultOnEvent } = {}) {
    super();
    if (!inner) throw new TypeError('SanitizingAdapter: inner adapter is required');
    this._inner = inner;
    this._vault = vault;
    this._onEvent = onEvent;
  }

  get name() { return `Sanitizing(${this._inner.name})`; }

  async plan(request, options = {})    { return this._call('plan', request, options); }
  async recover(request, options = {}) { return this._call('recover', request, options); }
  async explain(request, options = {}) { return this._call('explain', request, options); }
  async ask(request, options = {})     { return this._call('ask', request, options); }

  estimateCost(operation, request) { return this._inner.estimateCost(operation, request); }
  async checkAvailability()        { return this._inner.checkAvailability(); }

  async _call(method, request, options) {
    const tally = {};
    let safe;
    try {
      safe = sanitizeDeep(request, this._vault, tally);
    } catch {
      this._emit({ event: 'sanitize_failed', method });
      return SanitizingAdapter._failure();
    }
    if (Object.keys(tally).length) {
      this._emit({ event: 'pii_redacted', method, types: tally, placeholders: this._vault.size });
    }
    const response = await this._inner[method](safe, options);
    return restoreDeep(response, this._vault);
  }

  _emit(evt) {
    try {
      this._onEvent(evt);
    } catch {
      // a logging failure must never affect the request
    }
  }

  static _failure() {
    return {
      schemaVersion:    '1',
      result:           'FAILED',
      blockers:         [],
      confidence:       0,
      providerMetadata: { provider: 'sanitizer', model: 'none', plannerVersion: 'unknown', latencyMs: 0 },
      error:            'Privacy sanitization failed; the request was not sent.',
      errorCode:        'SANITIZE_ERROR'
    };
  }
}
