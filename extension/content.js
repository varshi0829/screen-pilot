// ScreenPilot - Content Script

(function () {
  'use strict';

  console.log('[Content] File loaded');

  const DEBUG = false;
  const LOW_CONFIDENCE_THRESHOLD    = 0.5;
  const WARNING_CONFIDENCE_THRESHOLD = 0.8;
  const REANALYZE_DEBOUNCE_MS   = 1200;
  const CLICK_REANALYZE_DELAY_MS = 900;
  const MATCH_HARD_FLOOR   = 40;   // scores below this are noise regardless of context
  const AMBIGUITY_DELTA    = 5;    // winner vs runner-up gap below this → flag ambiguous
  // Minimum DOM match score to trust a plan step without a Gemini call.
  // Higher than MATCH_HARD_FLOOR — we're skipping Gemini so we need more confidence.
  const PLAN_STEP_MIN_SCORE = 70;
  // Secondary threshold: use DOMMatcher alternatives before falling back to Gemini.
  const PLAN_RECOVERY_MIN_SCORE = 50;

  // Stage definitions for progressive loading UI
  const STAGES = ['understanding', 'capturing', 'analyzing', 'matching'];

  // ─── PERF TRACER ────────────────────────────────────────────────────────────
  // Measures each phase of an analysis cycle and prints a structured table.
  // Phases: screenshot → gemini → dom_match → highlight
  // Identifies the largest bottleneck without guessing.

  const PerfTracer = (() => {
    let _t0 = 0, _prev = 0, _goal = '';
    const _phases = [];

    function begin(goal) {
      _t0 = _prev = performance.now();
      _goal = goal;
      _phases.length = 0;
    }

    function mark(label) {
      const now = performance.now();
      _phases.push({ label, fromStart: Math.round(now - _t0), delta: Math.round(now - _prev) });
      _prev = now;
    }

    function report() {
      if (!_phases.length) return;
      const total = Math.round(performance.now() - _t0);
      console.groupCollapsed(`[ScreenPilot Perf] ${total}ms — "${_goal.slice(0, 50)}"`);
      console.table(Object.fromEntries(
        _phases.map(p => [p.label, { 'ms (cumulative)': p.fromStart, 'ms (this phase)': p.delta }])
      ));
      console.groupEnd();
    }

    return { begin, mark, report };
  })();

  // ─── PAGE STATE CACHE ────────────────────────────────────────────────────────
  // Caches the last Gemini response keyed by URL + goal + DOM fingerprint.
  // Cache is invalidated when the DOM changes significantly (PageObserver fires)
  // or when 25s have elapsed — whichever comes first.
  // This prevents redundant API calls when the user presses Go on an unchanged page.
  // Cache is based on observable page state, never on application identity.

  const PageStateCache = (() => {
    const TTL_MS = 25_000;
    let _entry = null;

    function domSignature() {
      // Sample visible interactive elements — lightweight, no crypto API needed.
      // Covers up to 60 elements; text is truncated to avoid length explosions.
      const els = document.querySelectorAll(
        'button,a,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]'
      );
      let s = '';
      let n = 0;
      for (const el of els) {
        if (!DOMMatcher.isVisible(el)) continue;
        s += (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 20) + '|';
        if (++n >= 60) break;
      }
      return fnv32a(s);
    }

    function fnv32a(str) {
      // FNV-1a 32-bit — fast, low collision rate for typical DOM samples
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(36);
    }

    function makeKey(goal) {
      return `${window.location.href}::${goal}::${domSignature()}`;
    }

    function get(goal) {
      if (!_entry) return null;
      if (Date.now() - _entry.at > TTL_MS) { _entry = null; return null; }
      if (_entry.key !== makeKey(goal)) return null;
      console.log('[Cache] HIT — returning cached analysis (same URL + goal + DOM)');
      return _entry.response;
    }

    function set(goal, response) {
      _entry = { key: makeKey(goal), response, at: Date.now() };
      console.log('[Cache] SET —', _entry.key.slice(0, 80));
    }

    function invalidate(reason) {
      if (_entry) console.log('[Cache] INVALIDATE —', reason);
      _entry = null;
    }

    return { get, set, invalidate };
  })();

  let state = {
    isOpen: false,
    status: 'IDLE',
    statusMessage: 'Ready',
    goal: '',
    currentAction: null,
    currentTaskState: null,
    highlightedElement: null,
    reanalyzeTimer: null,
    awaitingUpdate: false,
    requestInFlight: false,
    currentUrl: window.location.href,
    activeRequestToken: 0,
    historyCollapsed: false,
    lastReanalysisAt: 0,
    lastUserInteractionAt: 0,
    lastTriggerReason: '',
    restoreTriggered: false,
    confidenceLevel: 'normal',
    enterpriseContext: null,   // populated before each Gemini call
    geminiCallCount:  0,       // incremented each time a Gemini round-trip fires (not cache)
  };

  // Debug event emitter — dispatches a CustomEvent that debug-overlay.js listens to.
  // No-ops if the debug overlay is not loaded (window.__SP_DEBUG__ is falsy).
  function _emitDebug(type, detail = {}) {
    if (!window.__SP_DEBUG__) return;
    try {
      window.dispatchEvent(new CustomEvent('sp-debug', { detail: { type, ...detail } }));
    } catch (_) {}
  }

  // ─── HIGHLIGHTER ────────────────────────────────────────────────────────────

  const Highlighter = {
    spotlight: null,
    ring: null,
    arrow: null,
    bubble: null,

    async show(element, instructionText) {
      this.clear();
      if (!element) return false;

      await scrollIntoViewIfNeeded(element);
      if (!isElementActionable(element) || !isInViewport(element)) return false;

      const rect = element.getBoundingClientRect();
      const PAD  = 5;

      // — Spotlight ————————————————————————————————
      const spotlight = document.createElement('div');
      spotlight.id = 'screenpilot-spotlight';
      applyRect(spotlight, rect, PAD);
      document.body.appendChild(spotlight);
      this.spotlight = spotlight;

      // — Highlight ring ——————————————————————————
      const ring = document.createElement('div');
      ring.id = 'screenpilot-highlight';
      applyRect(ring, rect, PAD);
      document.body.appendChild(ring);
      this.ring = ring;

      // — Arrow ————————————————————————————————————
      const arrow = document.createElement('div');
      arrow.id = 'screenpilot-arrow';
      // Position above element; fall back to below if near top
      const arrowSize = 32;
      const arrowTop  = rect.top - PAD - arrowSize - 6;
      const clampedArrowTop = arrowTop < 8 ? rect.bottom + PAD + 4 : arrowTop;
      arrow.style.cssText = `top:${clampedArrowTop}px;left:${rect.left + rect.width / 2 - arrowSize / 2}px;`;
      const arrowPointsDown = arrowTop >= 8;
      arrow.innerHTML = arrowPointsDown
        ? `<svg viewBox="0 0 24 24" fill="#FF0000" xmlns="http://www.w3.org/2000/svg"><path d="M12 4v12m0 0l-4-4m4 4l4-4" stroke="#FF0000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="12" cy="20" r="2" fill="#FF0000"/></svg>`
        : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 20V8m0 0l-4 4m4-4l4 4" stroke="#FF0000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="12" cy="4" r="2" fill="#FF0000"/></svg>`;
      document.body.appendChild(arrow);
      this.arrow = arrow;

      // — Instruction bubble ———————————————————————
      const bubble = document.createElement('div');
      bubble.id = 'screenpilot-bubble';
      bubble.textContent = instructionText;
      document.body.appendChild(bubble);

      // Position bubble: prefer above; shift to avoid edges
      const bubbleEstW = Math.min(320, window.innerWidth - 32);
      let bubbleLeft = rect.left + rect.width / 2 - bubbleEstW / 2;
      bubbleLeft = Math.max(12, Math.min(bubbleLeft, window.innerWidth - bubbleEstW - 12));
      const spaceAbove = rect.top - PAD - arrowSize - 44;
      const bubbleAbove = spaceAbove > 50;
      const bubbleTop  = bubbleAbove
        ? rect.top - PAD - arrowSize - 44
        : rect.bottom + PAD + arrowSize + 8;
      bubble.style.cssText = `top:${bubbleTop}px;left:${bubbleLeft}px;max-width:${bubbleEstW}px;`;
      bubble.classList.add(bubbleAbove ? 'sp-bubble-above' : 'sp-bubble-below');
      this.bubble = bubble;

      // Animate all in next frame
      requestAnimationFrame(() => {
        spotlight.classList.add('sp-visible');
        ring.classList.add('sp-visible');
        arrow.classList.add('sp-visible');
        bubble.classList.add('sp-visible');
      });

      return true;
    },

    clear() {
      [this.spotlight, this.ring, this.arrow, this.bubble].forEach(el => {
        if (!el) return;
        el.classList.remove('sp-visible');
        setTimeout(() => el.remove(), 320);
      });
      this.spotlight = this.ring = this.arrow = this.bubble = null;
    }
  };

  function applyRect(el, rect, pad = 0) {
    el.style.top    = `${rect.top    - pad}px`;
    el.style.left   = `${rect.left   - pad}px`;
    el.style.width  = `${rect.width  + pad * 2}px`;
    el.style.height = `${rect.height + pad * 2}px`;
  }

  // ─── PAGE OBSERVER ──────────────────────────────────────────────────────────

  const PageObserver = {
    observer: null,
    debounceTimer: null,

    start() {
      this.stop();
      if (!document.body) return;

      this.observer = new MutationObserver((records) => {
        if (records.every((r) => isScreenPilotMutation(r))) return;
        this.queueChange('Page updated');
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false,
        // Only watch attributes that signal meaningful UI state changes.
        // Omitting class, style, data-*, aria-busy prevents thousands of
        // animation/counter/loading-state mutations from triggering re-analysis.
        attributeFilter: [
          'hidden', 'disabled', 'aria-disabled', 'aria-hidden',
          'aria-expanded', 'aria-selected', 'aria-checked',
          'aria-invalid', 'aria-current', 'aria-pressed',
          'href', 'src', 'value', 'open', 'checked', 'selected'
        ],
      });

      window.addEventListener('popstate',   this.handleUrlChange, true);
      window.addEventListener('hashchange', this.handleUrlChange, true);
    },

    stop() {
      this.observer?.disconnect();
      this.observer = null;
      clearTimeout(this.debounceTimer);
      window.removeEventListener('popstate',   this.handleUrlChange, true);
      window.removeEventListener('hashchange', this.handleUrlChange, true);
    },

    handleUrlChange() {
      PageObserver.queueChange('Navigation detected');
    },

    queueChange(reason) {
      if (!state.goal || state.awaitingUpdate || state.requestInFlight) return;
      if (state.status === 'COMPLETE' || state.status === 'ERROR') return;
      if (state.status === 'HIGHLIGHTING') { console.log(`[Guard] queueChange blocked: HIGHLIGHTING, reason=${reason}`); return; }

      const now = Date.now();
      if (now - state.lastReanalysisAt < REANALYZE_DEBOUNCE_MS) return;

      // Invalidate cached response — the DOM changed, so the previous plan may
      // no longer match the current UI state. Re-planning is required.
      PageStateCache.invalidate(reason);

      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        state.currentUrl = window.location.href;
        triggerReanalysis(reason);
      }, REANALYZE_DEBOUNCE_MS);
    }
  };

  // ─── PLAN EXECUTOR ──────────────────────────────────────────────────────────
  // DOM-first step execution. When a TaskPlan exists, tries to find the next
  // expected element in the live DOM without calling Gemini.
  // Falls back to full REANALYZE if the element cannot be found or scored too low.

  function tryPlanStep() {
    const plan = state.currentTaskState?.taskPlan;
    if (!plan?.steps?.length) return null;

    const nextIdx = plan.currentStepIndex + 1;
    if (nextIdx >= plan.steps.length) return null;

    const step = plan.steps[nextIdx];
    if (!step?.expectedElement?.text) return null;
    if (step.status === 'done') return null;

    const match = DOMMatcher.matchElement(step.expectedElement);

    // Primary match: high-confidence DOM hit
    if (match?.element && match.score >= PLAN_STEP_MIN_SCORE) {
      console.log(`[Plan] Step ${nextIdx} found: "${step.description}" (DOM score: ${match.score})`);
      console.log(`[Transition] Chosen: "${step.expectedElement.text}", Score: ${match.score}, State: ${step.state}`);
      _emitDebug('PLAN_STEP_PRIMARY', { stepIndex: nextIdx, score: match.score, description: step.description });
      chrome.runtime.sendMessage({ type: 'TELEMETRY_EVENT', event: 'PLAN_STEP_RECOVERED' }).catch(() => {});
      return { element: match.element, step, stepIndex: nextIdx, matchScore: match.score };
    }

    // Recovery tier 1: try ranked alternatives from the same matchElement call
    if (Array.isArray(match?.alternatives)) {
      for (const alt of match.alternatives) {
        if (alt?.element && alt.score >= PLAN_RECOVERY_MIN_SCORE) {
          console.log(`[Plan] Step ${nextIdx} recovered via alternative: score=${alt.score}`);
          _emitDebug('PLAN_STEP_RECOVERY_1', { stepIndex: nextIdx, score: alt.score, description: step.description });
          chrome.runtime.sendMessage({ type: 'TELEMETRY_EVENT', event: 'PLAN_STEP_RECOVERED', detail: { stepIndex: nextIdx, score: alt.score, description: step.description, recoveryTier: 'alternatives' } }).catch(() => {});
          return { element: alt.element, step, stepIndex: nextIdx, matchScore: alt.score };
        }
      }
    }

    // Recovery tier 2: semantic token search on visible interactive elements
    const recovered = findBySemanticSearch(step.description, step.expectedElement?.type);
    if (recovered) {
      console.log(`[Plan] Step ${nextIdx} recovered via semantic search: "${recovered.textContent?.trim().slice(0, 40)}"`);
      _emitDebug('PLAN_STEP_RECOVERY_2', { stepIndex: nextIdx, score: PLAN_RECOVERY_MIN_SCORE, description: step.description });
      chrome.runtime.sendMessage({ type: 'TELEMETRY_EVENT', event: 'PLAN_STEP_RECOVERED', detail: { stepIndex: nextIdx, score: PLAN_RECOVERY_MIN_SCORE, description: step.description, recoveryTier: 'semantic' } }).catch(() => {});
      return { element: recovered, step, stepIndex: nextIdx, matchScore: PLAN_RECOVERY_MIN_SCORE };
    }

    // All recovery paths exhausted — Gemini fallback
    console.log(`[Plan] Step ${nextIdx} not found — score ${match?.score ?? 'n/a'}, falling back to Gemini`);
    _emitDebug('PLAN_STEP_FAILED', { stepIndex: nextIdx, score: match?.score ?? null, description: step.description, recoveryTier: 'exhausted' });
    chrome.runtime.sendMessage({ type: 'TELEMETRY_EVENT', event: 'PLAN_STEP_FAILED', detail: { stepIndex: nextIdx, score: match?.score ?? null, description: step.description, recoveryTier: 'exhausted' } }).catch(() => {});
    return null;
  }

  // Lightweight semantic token search — splits the step description into tokens and looks
  // for a visible interactive element whose accessible text contains all significant tokens.
  function findBySemanticSearch(description, elementType) {
    if (!description) return null;
    const INTERACTIVE = 'button,a,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"]';
    const stopWords   = new Set(['the','a','an','to','in','on','at','of','and','or','for','with','click','press','open','select','choose','go']);

    const tokens = description.toLowerCase().replace(/['"]/g, '').split(/\s+/).filter(t => t.length > 1 && !stopWords.has(t));
    if (!tokens.length) return null;

    const candidates = Array.from(document.querySelectorAll(INTERACTIVE)).filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      if (window.getComputedStyle(el).display === 'none') return false;
      return true;
    });

    let best = null, bestScore = 0;
    for (const el of candidates) {
      const text  = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').toLowerCase();
      const score = tokens.filter(t => text.includes(t)).length / tokens.length;
      if (score > bestScore && score >= 0.5) { best = el; bestScore = score; }
    }
    return best;
  }

  async function executePlanStep({ element, step, stepIndex, matchScore }) {
    PerfTracer.begin(state.goal);
    PerfTracer.mark('plan_dom_match');

    // Notify background to advance plan state — lightweight, no Gemini call
    let response = null;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'ADVANCE_PLAN_STEP',
        stepIndex,
        instruction: step.description,
      });
    } catch (err) {
      console.warn('[Plan] ADVANCE_PLAN_STEP failed:', err?.message);
    }

    if (!response?.success) {
      // Background rejected the advance — fall back to full reanalysis
      console.warn('[Plan] Background rejected plan advance, falling back to Gemini');
      state.requestInFlight = false;
      state.awaitingUpdate = false;
      requestAnalysis('REANALYZE', 'plan-advance-rejected');
      return;
    }

    state.highlightedElement = element;
    const highlighted = await Highlighter.show(element, step.description);
    PerfTracer.mark('highlight');

    if (!highlighted) {
      // Element exists in DOM but is off-screen or not actionable — fall back
      console.warn('[Plan] Plan step element not highlightable, falling back to Gemini');
      state.highlightedElement = null;
      state.requestInFlight = false;
      state.awaitingUpdate = false;
      requestAnalysis('REANALYZE', 'plan-step-not-visible');
      return;
    }

    // Commit state after successful highlight
    state.currentTaskState   = response.state || state.currentTaskState;
    state.currentAction      = { instruction: step.description, targetElement: step.expectedElement };
    state.confidenceLevel    = matchScore >= 100 ? 'normal' : matchScore >= 70 ? 'warning' : 'low';
    state.lastReanalysisAt   = Date.now();
    state.awaitingUpdate     = false;
    state.requestInFlight    = false;

    setStatus('HIGHLIGHTING', step.description);
    PageObserver.start();
    PerfTracer.report();
    renderProgressPanel();
  }

  // ─── UNIVERSAL PLANNER ──────────────────────────────────────────────────────
  // Data-driven element selection. Zero site-specific logic.
  // Ranks Gemini's candidates using 8 generic DOM + visual signals.

  const UniversalPlanner = (() => {

    // How much each generic action type biases the score upward.
    // Tuned so explicit CTAs rank highest; destructive actions rank lowest.
    const ACTION_TYPE_WEIGHT = {
      primary_action:     1.00,
      input_field:        0.90,
      menu_action:        0.80,
      navigation_action:  0.75,
      filter_control:     0.70,
      content_item:       0.65,
      secondary_action:   0.50,
      settings_control:   0.50,
      destructive_action: 0.30
    };

    // Regions that contain interactive controls rank above passive regions.
    const REGION_WEIGHT = {
      modal:           1.00,
      form:            0.90,
      toolbar:         0.80,
      main_content:    0.75,
      dropdown:        0.70,
      top_navigation:  0.55,
      side_navigation: 0.50,
      footer:          0.30
    };

    // Weights must sum to 1.0
    const SIGNAL_WEIGHT = {
      geminiConfidence:   0.30,
      domMatchScore:      0.25,
      clickability:       0.15,
      semanticSimilarity: 0.12,
      visibility:         0.08,
      actionTypeWeight:   0.05,
      regionWeight:       0.03,
      visualProminence:   0.02
    };

    // Map from Gemini's 9 generic action types → DOMMatcher element type hint.
    const ACTION_TO_ELEMENT_TYPE = {
      primary_action:     'button',
      secondary_action:   'button',
      navigation_action:  'link',
      destructive_action: 'button',
      menu_action:        'menu',
      content_item:       'link',
      input_field:        'input',
      filter_control:     'input',
      settings_control:   'button'
    };

    /**
     * Select the best DOM element from Gemini's ranked candidates[].
     * Returns { element, actionType, region, score, signals, domMatchType, candidate } or null.
     */
    function selectBest(candidates, goal) {
      if (!Array.isArray(candidates) || !candidates.length) {
        return null;
      }

      const goalTokens = tokenize(goal);
      const ranked = [];

      for (const candidate of candidates) {
        if (!candidate?.text?.trim()) {
          continue;
        }

        const elementType = candidate.elementType || ACTION_TO_ELEMENT_TYPE[candidate.actionType] || 'button';
        const domMatch = DOMMatcher.matchElement({ text: candidate.text, type: elementType });
        if (!domMatch?.element) continue;

        const signals = computeSignals(domMatch.element, goalTokens, candidate, domMatch.score);
        const score   = computeScore(signals);

        ranked.push({
          element:       domMatch.element,
          actionType:    candidate.actionType,
          region:        candidate.region,
          score,
          signals,
          domMatchScore: domMatch.score,
          domMatchType:  domMatch.matchType,
          candidate
        });
      }

      if (!ranked.length) return null;
      ranked.sort((a, b) => b.score - a.score);

      console.log('[UniversalPlanner] Ranked:',
        ranked.map(r => `"${r.candidate.text}"(${r.actionType}@${r.region}=${r.score.toFixed(3)})`).join(' | '));

      return ranked[0];
    }

    function computeSignals(element, goalTokens, candidate, domMatchScore) {
      const rawDom  = domMatchScore || 0;
      const normDom = clamp(rawDom / 200); // 200 = hard cap in scoreElement()
      console.log(`[Planner] DOM score raw: ${rawDom} | normalized: ${normDom.toFixed(3)}`);
      return {
        geminiConfidence:   clamp(candidate.confidence || 0),
        domMatchScore:      normDom,
        clickability:       computeClickability(element),
        semanticSimilarity: computeSemanticSimilarity(element, goalTokens),
        visibility:         computeVisibility(element),
        actionTypeWeight:   ACTION_TYPE_WEIGHT[candidate.actionType] ?? 0.5,
        regionWeight:       REGION_WEIGHT[candidate.region] ?? 0.5,
        visualProminence:   computeVisualProminence(element)
      };
    }

    function computeScore(signals) {
      return Object.entries(SIGNAL_WEIGHT).reduce(
        (total, [key, w]) => total + (signals[key] || 0) * w, 0
      );
    }

    function computeVisualProminence(element) {
      try {
        const rect  = element.getBoundingClientRect();
        const area  = rect.width * rect.height;
        const vArea = window.innerWidth * window.innerHeight;
        return vArea > 0 ? clamp(area / (vArea * 0.05)) : 0;
      } catch { return 0; }
    }

    function computeVisibility(element) {
      try {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return 0;
        return (rect.top  < window.innerHeight && rect.bottom > 0 &&
                rect.left < window.innerWidth  && rect.right  > 0) ? 1 : 0.2;
      } catch { return 0; }
    }

    function computeClickability(element) {
      const tag  = element.tagName?.toLowerCase() || '';
      const role = element.getAttribute?.('role') || '';
      if (['button', 'a', 'select', 'textarea'].includes(tag)) return 1;
      if (tag === 'input') return element.getAttribute('type') === 'hidden' ? 0 : 1;
      if (['button', 'link', 'menuitem', 'option', 'checkbox',
           'radio', 'switch', 'tab', 'textbox', 'combobox'].includes(role)) return 1;
      if (element.isContentEditable) return 0.9;
      try { if (window.getComputedStyle(element).cursor === 'pointer') return 0.8; } catch { /* ignore */ }
      if (element.getAttribute?.('tabindex') !== null) return 0.7;
      return 0.2;
    }

    function computeSemanticSimilarity(element, goalTokens) {
      if (!goalTokens.length) return 0;
      const raw = [
        element.innerText, element.textContent,
        element.getAttribute?.('aria-label'), element.getAttribute?.('title'),
        element.getAttribute?.('placeholder'), element.getAttribute?.('name')
      ].filter(Boolean).join(' ');
      const elemSet = new Set(tokenize(raw));
      const goalSet = new Set(goalTokens);
      const inter   = [...goalSet].filter(t => elemSet.has(t)).length;
      const union   = new Set([...goalSet, ...elemSet]).size;
      return union === 0 ? 0 : inter / union;
    }

    // Retained from old planner — site-agnostic score floor + ambiguity detection.
    function adaptiveScoreCheck(match) {
      if (!match) return { valid: false, ambiguous: false, reason: 'no match' };
      const winner   = match.score;
      const runnerUp = match.alternatives?.[0]?.score ?? 0;
      const delta    = winner - runnerUp;

      console.log('[UniversalPlanner] DOM score:', winner,
        '| runner-up:', runnerUp || 'none', '| delta:', runnerUp ? delta : 'n/a');

      if (winner < MATCH_HARD_FLOOR) {
        return { valid: false, ambiguous: false,
          reason: `score ${winner} below floor ${MATCH_HARD_FLOOR}` };
      }
      if (runnerUp > 0 && delta < AMBIGUITY_DELTA) {
        return { valid: true, ambiguous: true, delta,
          reason: `ambiguous — ${winner} vs ${runnerUp} (delta ${delta})` };
      }
      return { valid: true, ambiguous: false, delta };
    }

    function tokenize(text) {
      return typeof text === 'string'
        ? text.replace(/\s+/g, ' ').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        : [];
    }

    function clamp(v) { return Math.max(0, Math.min(1, v)); }

    return { selectBest, adaptiveScoreCheck };
  })();

  // ─── WIDGET ─────────────────────────────────────────────────────────────────

  function createWidget() {
    if (document.getElementById('screenpilot-widget')) {
      console.log('[SP:LAUNCH] createWidget(): widget already in DOM, skipping');
      return;
    }

    console.log('[SP:LAUNCH] createWidget(): creating widget element');

    const widget = document.createElement('div');
    widget.id = 'screenpilot-widget';
    widget.innerHTML = `
      <div class="sp-header">
        <div class="sp-logo">
          <div class="sp-logo-icon">✈</div>
          <span class="sp-title">ScreenPilot</span>
          <span class="sp-page-host">${window.location.hostname}</span>
        </div>
        <div class="sp-controls">
          <button class="sp-icon-btn sp-btn-minimize" title="Minimize">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14" stroke-linecap="round"/></svg>
          </button>
          <button class="sp-icon-btn sp-btn-close" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M18 6 6 18M6 6l12 12" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>

      <div class="sp-body">
        <div class="sp-input-wrap">
          <textarea class="sp-goal-input" placeholder="What do you want to do?" rows="3"></textarea>
          <div class="sp-input-footer">
            <button class="sp-btn-go">
              <span class="sp-btn-go-label">Go</span>
              <span class="sp-btn-go-arrow">→</span>
            </button>
          </div>
        </div>

        <div class="sp-stages" hidden>
          ${STAGES.map(s => `
            <div class="sp-stage" data-stage="${s}">
              <div class="sp-stage-dot"></div>
              <span class="sp-stage-label">${stageLabel(s)}</span>
              <span class="sp-stage-check">✓</span>
            </div>`).join('')}
        </div>

        <div class="sp-progress-panel">
          <button class="sp-progress-toggle" type="button" aria-expanded="true">
            <span class="sp-progress-title">Task Progress</span>
            <span class="sp-progress-chevron">▾</span>
          </button>
          <div class="sp-progress-content">
            <div class="sp-goal-summary">
              Goal: <span class="sp-goal-summary-text">Not started</span>
              <span class="sp-step-counter" hidden></span>
            </div>
            <div class="sp-confidence-badge sp-hidden"></div>
            <ul class="sp-step-list"></ul>
          </div>
        </div>

        <div class="sp-status-bar sp-status-idle">
          <div class="sp-status-dot"></div>
          <span class="sp-status-text">Ready</span>
        </div>

        <div class="sp-footer-actions">
          <button class="sp-btn-cancel">Cancel</button>
          <button class="sp-btn-secondary sp-btn-explain" title="Explain this screen">Explain</button>
          <button class="sp-btn-secondary sp-btn-ask" title="Ask a question about this screen">Ask</button>
        </div>

        <div class="sp-explain-panel" hidden>
          <div class="sp-explain-header">
            <span class="sp-explain-title">Screen Explanation</span>
            <button class="sp-explain-close" title="Close">✕</button>
          </div>
          <div class="sp-explain-body sp-explain-content"></div>
        </div>

        <div class="sp-qa-bar" hidden>
          <input class="sp-qa-input" type="text" placeholder="Ask about this screen…" maxlength="200" />
          <button class="sp-qa-submit" title="Ask">→</button>
        </div>
        <div class="sp-qa-answer" hidden>
          <div class="sp-qa-answer-label">Answer</div>
          <div class="sp-qa-answer-text"></div>
        </div>

        <div class="sp-complete-overlay" hidden>
          <div class="sp-complete-checkmark">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div class="sp-complete-title">Task complete!</div>
          <div class="sp-complete-subtitle sp-complete-msg"></div>
          <button class="sp-btn-done">Done</button>
        </div>
      </div>
    `;

    document.body.appendChild(widget);
    const verify = !!document.getElementById('screenpilot-widget');
    console.log('[SP:LAUNCH] createWidget(): appended to body, getElementById verify=', verify);
    attachWidgetEvents(widget);
    renderProgressPanel();
  }

  function stageLabel(stage) {
    return {
      understanding: 'Understanding your goal',
      capturing:     'Capturing the screen',
      analyzing:     'Analyzing with AI',
      matching:      'Finding target element'
    }[stage] || stage;
  }

  function attachWidgetEvents(widget) {
    const input    = widget.querySelector('.sp-goal-input');
    const goButton = widget.querySelector('.sp-btn-go');

    goButton.addEventListener('click', async () => {
      const goal = input.value.trim();
      if (!goal) {
        setStatus('ERROR', 'Enter a goal to start.');
        return;
      }

      state.goal = goal;
      state.currentUrl = window.location.href;
      state.restoreTriggered = false;
      state.currentTaskState = null;
      setStatus('ANALYZING', 'Starting…');
      await requestAnalysis('ANALYZE_GOAL');
    });

    widget.querySelector('.sp-btn-cancel').addEventListener('click', resetWorkflow);
    widget.querySelector('.sp-btn-close').addEventListener('click', closeWidget);
    widget.querySelector('.sp-btn-done').addEventListener('click', () => {
      hideCompleteOverlay();
      resetWorkflow();
    });

    widget.querySelector('.sp-btn-minimize').addEventListener('click', () => {
      widget.classList.toggle('sp-minimized');
    });

    widget.querySelector('.sp-progress-toggle').addEventListener('click', () => {
      state.historyCollapsed = !state.historyCollapsed;
      renderProgressPanel();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        goButton.click();
      }
    });

    // Explain My Screen
    widget.querySelector('.sp-btn-explain').addEventListener('click', () => {
      const panel  = widget.querySelector('.sp-explain-panel');
      const qaBar  = widget.querySelector('.sp-qa-bar');
      const qaAns  = widget.querySelector('.sp-qa-answer');
      const isOpen = !panel.hidden;
      if (isOpen) {
        panel.setAttribute('hidden', '');
        widget.querySelector('.sp-btn-explain').classList.remove('sp-active');
      } else {
        qaBar.setAttribute('hidden', '');
        qaAns.setAttribute('hidden', '');
        widget.querySelector('.sp-btn-ask').classList.remove('sp-active');
        panel.removeAttribute('hidden');
        widget.querySelector('.sp-btn-explain').classList.add('sp-active');
        explainScreen(widget);
      }
    });

    widget.querySelector('.sp-explain-close').addEventListener('click', () => {
      widget.querySelector('.sp-explain-panel').setAttribute('hidden', '');
      widget.querySelector('.sp-btn-explain').classList.remove('sp-active');
    });

    // Screen Q&A
    widget.querySelector('.sp-btn-ask').addEventListener('click', () => {
      const qaBar  = widget.querySelector('.sp-qa-bar');
      const panel  = widget.querySelector('.sp-explain-panel');
      const isOpen = !qaBar.hidden;
      if (isOpen) {
        qaBar.setAttribute('hidden', '');
        widget.querySelector('.sp-btn-ask').classList.remove('sp-active');
      } else {
        panel.setAttribute('hidden', '');
        widget.querySelector('.sp-btn-explain').classList.remove('sp-active');
        widget.querySelector('.sp-qa-answer').setAttribute('hidden', '');
        qaBar.removeAttribute('hidden');
        widget.querySelector('.sp-btn-ask').classList.add('sp-active');
        widget.querySelector('.sp-qa-input').focus();
      }
    });

    const qaInput  = widget.querySelector('.sp-qa-input');
    const qaSubmit = widget.querySelector('.sp-qa-submit');

    qaSubmit.addEventListener('click', () => handleQuestion(widget));
    qaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleQuestion(widget); }
    });
  }

  // ─── STAGE UI ───────────────────────────────────────────────────────────────

  function showStages() {
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) return;
    const el = widget.querySelector('.sp-stages');
    el.removeAttribute('hidden');
    STAGES.forEach(s => setStageState(widget, s, 'waiting'));
  }

  function hideStages() {
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) return;
    widget.querySelector('.sp-stages').setAttribute('hidden', '');
  }

  function setStageState(widget, stage, state_) {
    // state_: 'waiting' | 'active' | 'done'
    const el = widget?.querySelector(`.sp-stage[data-stage="${stage}"]`);
    if (!el) return;
    el.dataset.state = state_;
  }

  function advanceStage(stage) {
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) return;
    const idx = STAGES.indexOf(stage);
    STAGES.forEach((s, i) => {
      setStageState(widget, s,
        i < idx  ? 'done'    :
        i === idx ? 'active'  :
        'waiting'
      );
    });
  }

  function finishAllStages() {
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) return;
    STAGES.forEach(s => setStageState(widget, s, 'done'));
  }

  // ─── GO BUTTON STATE ────────────────────────────────────────────────────────

  function setGoButtonLoading(loading) {
    const btn = document.querySelector('#screenpilot-widget .sp-btn-go');
    if (!btn) return;
    btn.disabled = loading;
    const label  = btn.querySelector('.sp-btn-go-label');
    const arrow  = btn.querySelector('.sp-btn-go-arrow');
    const existing = btn.querySelector('.sp-spinner');
    if (loading) {
      if (!existing) {
        const spinner = document.createElement('span');
        spinner.className = 'sp-spinner';
        btn.insertBefore(spinner, label);
      }
      label.textContent = 'Working';
      if (arrow) arrow.style.display = 'none';
    } else {
      existing?.remove();
      label.textContent = 'Go';
      if (arrow) arrow.style.display = '';
    }
  }

  // ─── EXPLAIN MY SCREEN ──────────────────────────────────────────────────────

  async function explainScreen(widget) {
    const body = widget.querySelector('.sp-explain-content');
    body.innerHTML = '<div class="sp-explain-row"><span class="sp-explain-row-value" style="color:var(--sp-text-3)">Analyzing screen…</span></div>';

    try {
      const response = await chrome.runtime.sendMessage({
        type:  'GET_SCREEN_EXPLANATION',
        url:   window.location.href,
        title: document.title,
      });
      if (!response?.success) {
        body.innerHTML = `<div class="sp-explain-row"><span class="sp-explain-row-value" style="color:var(--sp-red)">${escHtml(response?.error || 'Could not analyze screen.')}</span></div>`;
        return;
      }
      body.innerHTML = formatScreenContext(response.screenContext);
    } catch (err) {
      body.innerHTML = `<div class="sp-explain-row"><span class="sp-explain-row-value" style="color:var(--sp-red)">Failed: ${escHtml(err?.message || 'Unknown error')}</span></div>`;
    }
  }

  function formatScreenContext(ctx) {
    if (!ctx) return '<div class="sp-explain-row"><span class="sp-explain-row-value">No screen data available.</span></div>';
    const rows = [];
    if (ctx.application) rows.push(row('Application', ctx.application));
    if (ctx.pageType)    rows.push(row('Page Type',    ctx.pageType));
    if (ctx.screenSummary) rows.push(row('Summary',     ctx.screenSummary));
    if (ctx.visibleActions?.length)
      rows.push(row('Available Actions', ctx.visibleActions.join(', ')));
    if (ctx.importantElements?.length) {
      const items = ctx.importantElements.map(e => `<strong>${escHtml(e.label)}</strong>: ${escHtml(e.description)}`).join('<br>');
      rows.push(row('Key Elements', items, true));
    }
    return rows.join('') || '<div class="sp-explain-row"><span class="sp-explain-row-value">Screen analyzed — no structured data returned.</span></div>';
  }

  function row(label, value, raw = false) {
    return `<div class="sp-explain-row">
      <span class="sp-explain-row-label">${escHtml(label)}</span>
      <span class="sp-explain-row-value">${raw ? value : escHtml(value)}</span>
    </div>`;
  }

  // ─── SCREEN Q&A ─────────────────────────────────────────────────────────────

  async function handleQuestion(widget) {
    const input    = widget.querySelector('.sp-qa-input');
    const submit   = widget.querySelector('.sp-qa-submit');
    const ansPanel = widget.querySelector('.sp-qa-answer');
    const ansText  = widget.querySelector('.sp-qa-answer-text');
    const question = input.value.trim();
    if (!question) return;

    submit.disabled = true;
    ansPanel.removeAttribute('hidden');
    ansText.textContent = 'Thinking…';

    try {
      const response = await chrome.runtime.sendMessage({
        type:     'ASK_QUESTION',
        question,
        url:      window.location.href,
        title:    document.title,
      });
      if (!response?.success) {
        ansText.textContent = response?.error || 'Could not answer that question.';
        return;
      }
      ansText.textContent = response.answer;
    } catch (err) {
      ansText.textContent = 'Failed: ' + (err?.message || 'Unknown error');
    } finally {
      submit.disabled = false;
    }
  }

  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── CORE REQUEST FLOW ──────────────────────────────────────────────────────

  async function requestAnalysis(messageType, reason = '') {
    if (state.requestInFlight) return;

    const requestToken = ++state.activeRequestToken;
    state.requestInFlight  = true;
    state.awaitingUpdate   = messageType === 'REANALYZE';

    PerfTracer.begin(state.goal);

    // Show staged progress — advance immediately, no artificial delays
    if (messageType === 'ANALYZE_GOAL') {
      state.geminiCallCount = 0;
      _emitDebug('TASK_START', { goal: state.goal });
      setGoButtonLoading(true);
      showStages();
      advanceStage('understanding');
    }

    try {
      if (messageType === 'ANALYZE_GOAL') {
        advanceStage('capturing');
      }

      // ── Cache check (ANALYZE_GOAL only) ───────────────────────────────────
      // If the URL, goal, and DOM fingerprint are all identical to the last
      // successful response, skip the Gemini round-trip entirely.
      let response;
      if (messageType === 'ANALYZE_GOAL') {
        const cached = PageStateCache.get(state.goal);
        if (cached) {
          response = cached;
          PerfTracer.mark('cache_hit');
          _emitDebug('CACHE_HIT', {});
          chrome.runtime.sendMessage({ type: 'TELEMETRY_EVENT', event: 'CACHE_HIT' }).catch(() => {});
        }
      }

      if (!response) {
        // Collect enterprise context before every Gemini call (refresh on page changes)
        if (typeof EnterpriseContextService !== 'undefined') {
          try { state.enterpriseContext = EnterpriseContextService.detect(); } catch (_) {}
        }
        if (state.enterpriseContext?.application) {
          _emitDebug('ENTERPRISE_CONTEXT', {
            application: state.enterpriseContext.application,
            module:      state.enterpriseContext.module,
            confidence:  state.enterpriseContext.confidence,
          });
        }

        state.geminiCallCount++;
        console.log(`[CALL #${++_geminiCallSeq}] reason=${messageType === 'ANALYZE_GOAL' ? 'goal_submit' : reason || 'reanalyze'}`);
        _emitDebug('GEMINI_CALL', { callNumber: state.geminiCallCount, mode: messageType === 'ANALYZE_GOAL' ? 'navigate' : 'reanalyze' });

        const t0Gemini = performance.now();
        response = await chrome.runtime.sendMessage({
          type:             messageType,
          goal:             state.goal,
          url:              window.location.href,
          title:            document.title,
          reason,
          enterpriseContext: state.enterpriseContext || null,
        });
        const geminiMs = Math.round(performance.now() - t0Gemini);
        PerfTracer.mark('gemini_roundtrip');
        console.log(`[Perf] Gemini+screenshot: ${geminiMs}ms`);

        _emitDebug('GEMINI_RESPONSE', {
          latencyMs:  geminiMs,
          success:    !!response?.success,
          fromMemory: !!response?.fromMemory,
          stepCount:  response?.state?.taskPlan?.steps?.length ?? 0,
        });

        // Store successful response in cache for reuse if page state unchanged
        if (messageType === 'ANALYZE_GOAL' && response?.success) {
          PageStateCache.set(state.goal, response);
        }
      }

      console.log('[UniversalPlanner] Target:', response?.targetElement?.text, '|', response?.instruction);

      if (response?.fromMemory) _emitDebug('MEMORY_HIT', { confidence: response.confidence });
      else if (response?.success && messageType === 'ANALYZE_GOAL') _emitDebug('MEMORY_MISS', {});

      if (requestToken !== state.activeRequestToken) return;

      // Extract goal early for dedup — do NOT commit currentTaskState yet.
      // State is only committed after a successful highlight to avoid contradictory UI.
      if (response?.state?.goal) state.goal = response.state.goal;

      if (!response?.success) {
        hideStages();
        setStatus('ERROR', response?.error || 'ScreenPilot could not analyze this page.');
        state.requestInFlight = false;
        state.awaitingUpdate = false;
        return;
      }

      // Handle blocker response from 8-step architecture
      if (response.blocked || response.error?.includes('Sign in') || response.error?.includes('sign in')) {
        hideStages();
        setStatus('BLOCKED', response.error || 'Action blocked.');
        state.requestInFlight = false;
        state.awaitingUpdate = false;
        return;
      }

      if (response.complete) {
        state.currentTaskState = response?.state || state.currentTaskState;
        hideStages();
        completeWorkflow(response.instruction || 'Task complete');
        return;
      }

      if (response.confidence < LOW_CONFIDENCE_THRESHOLD) {
        const proceed = window.confirm('I am not fully confident. Continue?');
        if (!proceed) {
          chrome.runtime.sendMessage({ type: 'ABORT_TASK', reason: 'User declined low-confidence step' }).catch(() => {});
          hideStages();
          setStatus('ERROR', 'ScreenPilot paused because confidence is low.');
          return;
        }
      }

      // DOM matching — UniversalPlanner (candidates[]) with DOM-matcher fallback
      if (messageType === 'ANALYZE_GOAL') advanceStage('matching');

      let finalElement     = null;
      let finalText        = '';
      let finalInstruction = response.instruction || '';
      let actionSource     = 'gemini';

      const plannerResult = UniversalPlanner.selectBest(response.candidates, state.goal);

      // Handle case where Gemini found no candidates AND no targetElement
      if (!plannerResult && !response.targetElement?.text) {
        console.log('[UniversalPlanner] No candidates and no targetElement - Gemini could not identify elements');
        hideStages();
        setStatus('ERROR', 'Could not identify any actionable elements on this page.');
        return;
      }

      if (plannerResult) {
        finalElement     = plannerResult.element;
        finalText        = plannerResult.candidate?.text || '';
        finalInstruction = response.instruction || buildDefaultInstruction(finalText);
        actionSource     = 'universal-planner';

        console.log('[Planner Telemetry]', {
          source:     actionSource,
          actionType: plannerResult.actionType,
          region:     plannerResult.region,
          score:      plannerResult.score.toFixed(3),
          signals:    plannerResult.signals,
          text:       finalText
        });
      } else {
        // Fallback: try to match based on instruction text if targetElement is empty
        const instructionText = response.instruction || '';
        const targetText = response.targetElement?.text || '';
        
        // Try targetElement first, then fall back to instruction text
        let match = null;
        if (targetText) {
          match = DOMMatcher.matchElement(response.targetElement);
        }
        
        // If no match from targetElement, try instruction text (e.g., "Click Compose")
        if (!match?.element && instructionText) {
          // Extract the element text from instruction (e.g., "Click Compose" -> "Compose")
          const matchResult = instructionText.match(/['"]([^'"]+)['"]|Click\s+(\w+)/i);
          const searchText = matchResult ? (matchResult[1] || matchResult[2]) : instructionText;
          if (searchText) {
            match = DOMMatcher.matchElement({ text: searchText, type: 'button' });
          }
        }
        
        console.log('[UniversalPlanner] AI confidence:', response.confidence,
          '| Fallback DOM score:', match?.score ?? 'no match');

        if (match?.element) {
          const scoreCheck = UniversalPlanner.adaptiveScoreCheck(match);

          if (!scoreCheck.valid) {
            console.log('[UniversalPlanner] Rejected —', scoreCheck.reason);
            // Don't fail immediately - try to find any matching element
            const anyMatch = DOMMatcher.matchElement({ text: targetText || searchText, type: 'button' });
            if (anyMatch?.element) {
              match = anyMatch;
            } else {
              hideStages();
              setStatus('ERROR', `Could not confidently locate "${targetText || searchText}" on this page.`);
              return;
            }
          }

          if (scoreCheck.ambiguous) {
            console.warn('[UniversalPlanner] Ambiguous match —', scoreCheck.reason);
          }

          finalElement     = match.element;
          finalText        = targetText || searchText || '';
          finalInstruction = response.instruction || buildDefaultInstruction(finalText);
          actionSource     = 'dom-matcher-fallback';

          console.log('[Planner Telemetry]', {
            source:       actionSource,
            matchScore:   match.score,
            matchType:    match.matchType,
            ambiguous:    scoreCheck?.ambiguous,
            delta:        scoreCheck?.delta,
            topCandidates: (match.alternatives || []).slice(0, 3)
              .map(c => `${c.score}:${(c.reason || '').split(';')[0].trim()}`),
            text:         finalText
          });
        }
      }

      PerfTracer.mark('dom_match');

      if (!finalElement) {
        console.log('[UniversalPlanner] No element found for:', response.targetElement?.text);
        hideStages();
        setStatus('ERROR', buildMissingElementMessage(response.targetElement));
        return;
      }

      // ── Highlight ────────────────────────────────────────────────────────
      state.highlightedElement = finalElement;
      const highlighted = await Highlighter.show(finalElement, finalInstruction);
      PerfTracer.mark('highlight');

      if (!highlighted) {
        hideStages();
        setStatus('ERROR', `I found "${finalText}", but it is not actionable on screen yet.`);
        return;
      }

      // Commit state only after successful highlight (single source of truth)
      state.currentTaskState = response?.state || state.currentTaskState;
      state.currentAction    = response;
      state.confidenceLevel  = getConfidenceLevel(response.confidence);

      finishAllStages();
      setTimeout(hideStages, 600);
      setStatus('HIGHLIGHTING', finalInstruction);
      state.lastReanalysisAt = Date.now();
      PageObserver.start();
      PerfTracer.report();
    } catch (error) {
      hideStages();
      setStatus('ERROR', error?.message?.includes('Extension context invalidated')
        ? 'Extension was reloaded — refresh this page to reconnect.'
        : error?.message || 'Unexpected content-script error.');
    } finally {
      state.requestInFlight = false;
      state.awaitingUpdate  = false;
      setGoButtonLoading(false);
      renderProgressPanel();
    }
  }

  // ─── TRIGGER REANALYSIS ─────────────────────────────────────────────────────

  let _geminiCallSeq = 0;

  function triggerReanalysis(reason) {
    if (!state.goal || state.awaitingUpdate || state.requestInFlight) return;
    if (state.status === 'COMPLETE') {
      console.log('[PageObserver] Ignoring change because workflow is complete');
      return;
    }
    if (state.status === 'ERROR') {
      console.log('[PageObserver] Ignoring change because workflow has an error');
      return;
    }

    // ── Guard: while HIGHLIGHTING, only explicit clicks on the highlighted
    //    element may advance the workflow.  Focus/input/URL/mutation events
    //    must NEVER trigger a Gemini call during HIGHLIGHTING.
    if (state.status === 'HIGHLIGHTING' && reason !== 'Click detected') {
      console.log(`[Guard] triggerReanalysis blocked: HIGHLIGHTING, reason=${reason}`);
      return;
    }

    // On click: try the next plan step in the DOM before calling Gemini.
    // If found with sufficient confidence, execute locally and skip the round-trip.
    if (reason === 'Click detected') {
      const planStep = tryPlanStep();
      if (planStep) {
        console.log(`[Transition] SUCCESS: Next step found, executing: "${planStep.step.description}"`);
        state.awaitingUpdate     = true;
        state.requestInFlight    = true;
        state.highlightedElement = null;
        state.lastTriggerReason  = reason;
        Highlighter.clear();
        setStatus('ANALYZING', 'Following plan…');
        executePlanStep(planStep);
        return;
      } else {
        console.log(`[Transition] FALLBACK: No plan step found, calling Gemini`);
      }
    }

    state.awaitingUpdate   = true;
    state.lastReanalysisAt = Date.now();
    state.lastTriggerReason = reason;
    state.highlightedElement = null;
    Highlighter.clear();
    setStatus('OBSERVING', `${reason}. Re-checking…`);
    log('Reanalysis triggered:', reason);
    clearTimeout(state.reanalyzeTimer);
    state.reanalyzeTimer = setTimeout(() => requestAnalysis('REANALYZE', reason), CLICK_REANALYZE_DELAY_MS);
  }

  // ─── CLICK HANDLER ──────────────────────────────────────────────────────────

  function handleDocumentClick(event) {
    if (!state.goal || !state.highlightedElement || isScreenPilotNode(event.target)) return;

    if (state.highlightedElement.contains(event.target)) {
      const clickedElement = state.currentAction?.targetElement?.text || 'unknown';
      const currentState = state.currentTaskState?.taskPlan?.steps?.[state.currentTaskState?.taskPlan?.currentStepIndex]?.state || 'unknown';
      console.log(`[Transition] CLICK: "${clickedElement}", From: ${currentState}`);
      triggerRipple(event.clientX, event.clientY);
      state.lastUserInteractionAt = Date.now();
      triggerReanalysis('Click detected');
    }
  }

  function triggerRipple(x, y) {
    const ripple = document.createElement('div');
    ripple.className = 'sp-ripple';
    ripple.style.cssText = `left:${x}px;top:${y}px;width:40px;height:40px;`;
    document.body.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  }

  // ─── STATUS ─────────────────────────────────────────────────────────────────

  function setStatus(status, message) {
    if (state.status !== status) {
      console.log(`[State] Transition: ${state.status} → ${status}`);
    }
    state.status        = status;
    state.statusMessage = message;
    renderProgressPanel();
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  function renderProgressPanel() {
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) return;

    // URL in header
    widget.querySelector('.sp-page-host').textContent = window.location.hostname;

    // Progress toggle
    const progressContent = widget.querySelector('.sp-progress-content');
    const toggle = widget.querySelector('.sp-progress-toggle');
    progressContent.classList.toggle('sp-hidden', state.historyCollapsed);
    toggle.setAttribute('aria-expanded', String(!state.historyCollapsed));

    // Goal summary
    widget.querySelector('.sp-goal-summary-text').textContent = state.goal || 'Not started';

    // Step counter
    const taskState = state.currentTaskState;
    const completed = taskState?.completedSteps || [];
    const counter = widget.querySelector('.sp-step-counter');
    if (taskState?.status === 'ACTIVE' && completed.length > 0) {
      counter.textContent = `Step ${completed.length + 1}`;
      counter.removeAttribute('hidden');
    } else {
      counter.setAttribute('hidden', '');
    }

    // Confidence badge
    updateConfidenceBadge(widget.querySelector('.sp-confidence-badge'));

    // Step list
    const stepList = widget.querySelector('.sp-step-list');
    stepList.innerHTML = '';

    for (const step of completed) {
      stepList.appendChild(createStepItem(step, 'complete'));
    }

    // Only show active instruction when we have successfully highlighted an element.
    // If status is ERROR, show nothing — prevents contradictory instruction + error UI.
    if (taskState?.currentInstruction && taskState.status === 'ACTIVE' && state.status === 'HIGHLIGHTING') {
      stepList.appendChild(createStepItem(taskState.currentInstruction, 'current'));
      stepList.appendChild(createStepItem('Waiting for next update', 'pending'));
    } else if (!completed.length && state.status !== 'ERROR') {
      stepList.appendChild(createStepItem('Waiting to start', 'pending'));
    }

    if (
      taskState?.status === 'COMPLETE' &&
      taskState.currentInstruction &&
      completed[completed.length - 1] !== taskState.currentInstruction
    ) {
      stepList.appendChild(createStepItem(taskState.currentInstruction || 'Task complete', 'complete'));
    }

    // Status bar
    const bar  = widget.querySelector('.sp-status-bar');
    const text = widget.querySelector('.sp-status-text');
    bar.className  = `sp-status-bar sp-status-${state.status.toLowerCase()}`;
    text.textContent = state.statusMessage;
  }

  function updateConfidenceBadge(badge) {
    if (state.confidenceLevel === 'warning') {
      badge.textContent = '⚠ Medium confidence';
      badge.className   = 'sp-confidence-badge sp-confidence-warning';
      return;
    }
    if (state.confidenceLevel === 'low') {
      badge.textContent = '⚠ Low confidence';
      badge.className   = 'sp-confidence-badge sp-confidence-low';
      return;
    }
    badge.textContent = '';
    badge.className   = 'sp-confidence-badge sp-hidden';
  }

  function createStepItem(label, kind) {
    const item   = document.createElement('li');
    item.className = `sp-step-item sp-step-${kind}`;
    const marker = document.createElement('div');
    marker.className = 'sp-step-marker';
    marker.textContent = kind === 'complete' ? '✓' : kind === 'current' ? '→' : '';
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(marker);
    item.appendChild(text);
    return item;
  }

  // ─── COMPLETE WORKFLOW ──────────────────────────────────────────────────────

  function completeWorkflow(message) {
    _emitDebug('TASK_END', { status: 'complete', message });
    if (state.currentTaskState) {
      const prev = state.currentTaskState;
      state.currentTaskState = {
        ...prev,
        status: 'COMPLETE',
        currentInstruction: message,
        completedSteps: prev.currentInstruction &&
          prev.completedSteps[prev.completedSteps.length - 1] !== prev.currentInstruction
          ? [...prev.completedSteps, prev.currentInstruction]
          : prev.completedSteps
      };
    }

    state.status             = 'COMPLETE';
    state.statusMessage      = message;
    state.highlightedElement = null;
    state.awaitingUpdate     = false;
    Highlighter.clear();
    PageObserver.stop();
    chrome.runtime.sendMessage({ type: 'COMPLETE_TASK', message }).catch(() => {});
    log('Task completed:', message);
    renderProgressPanel();
    showCompleteOverlay(message);
    launchConfetti();
  }

  function showCompleteOverlay(message) {
    const overlay = document.querySelector('#screenpilot-widget .sp-complete-overlay');
    if (!overlay) return;
    overlay.querySelector('.sp-complete-msg').textContent = message;
    overlay.removeAttribute('hidden');
    requestAnimationFrame(() => overlay.classList.add('sp-visible'));
  }

  function hideCompleteOverlay() {
    const overlay = document.querySelector('#screenpilot-widget .sp-complete-overlay');
    if (!overlay) return;
    overlay.classList.remove('sp-visible');
    setTimeout(() => overlay.setAttribute('hidden', ''), 320);
  }

  // ─── CONFETTI ───────────────────────────────────────────────────────────────

  function launchConfetti() {
    const container = document.createElement('div');
    container.className = 'sp-confetti';
    document.body.appendChild(container);

    const colors = ['#FF0000', '#22C55E', '#3B82F6', '#F59E0B', '#8B5CF6', '#EC4899'];
    const count  = 60;

    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'sp-confetti-piece';
      const color = colors[i % colors.length];
      const left  = Math.random() * 100;
      const delay = Math.random() * 0.6;
      const dur   = 0.9 + Math.random() * 0.6;
      const size  = 6 + Math.random() * 6;
      piece.style.cssText = [
        `left:${left}%`,
        `background:${color}`,
        `width:${size}px`,
        `height:${size}px`,
        `animation-delay:${delay}s`,
        `animation-duration:${dur}s`
      ].join(';');
      container.appendChild(piece);
    }

    setTimeout(() => container.remove(), 2200);
  }

  // ─── RESET / OPEN / CLOSE ───────────────────────────────────────────────────

  async function resetWorkflow() {
    state.goal               = '';
    state.status             = 'IDLE';
    state.statusMessage      = 'Ready';
    state.currentAction      = null;
    state.currentTaskState   = null;
    state.highlightedElement = null;
    state.awaitingUpdate     = false;
    state.requestInFlight    = false;
    state.confidenceLevel    = 'normal';
    state.restoreTriggered   = false;
    state.lastReanalysisAt   = 0;
    state.lastTriggerReason  = '';
    state.activeRequestToken += 1;
    clearTimeout(state.reanalyzeTimer);
    Highlighter.clear();
    PageObserver.stop();
    hideStages();
    setGoButtonLoading(false);
    hideCompleteOverlay();

    chrome.runtime.sendMessage({ type: 'ABORT_TASK', reason: 'User cancelled' }).catch(() => {});

    const widget = document.getElementById('screenpilot-widget');
    if (widget) {
      widget.querySelector('.sp-goal-input').value = '';
      widget.querySelector('.sp-explain-panel')?.setAttribute('hidden', '');
      widget.querySelector('.sp-qa-bar')?.setAttribute('hidden', '');
      widget.querySelector('.sp-qa-answer')?.setAttribute('hidden', '');
      widget.querySelector('.sp-btn-explain')?.classList.remove('sp-active');
      widget.querySelector('.sp-btn-ask')?.classList.remove('sp-active');
    }

    renderProgressPanel();
  }

  function openWidget() {
    console.log('[SP:LAUNCH] openWidget() called');
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) {
      console.error('[SP:LAUNCH] openWidget(): #screenpilot-widget NOT in DOM — widget was never created or was removed');
      return;
    }
    console.log('[SP:LAUNCH] openWidget(): widget found, classes before:', widget.className || '(none)');
    state.isOpen = true;
    widget.classList.add('sp-open');
    console.log('[SP:LAUNCH] openWidget(): sp-open added, classes after:', widget.className);
    setTimeout(() => widget.querySelector('.sp-goal-input')?.focus(), 50);
  }

  function closeWidget() {
    const widget = document.getElementById('screenpilot-widget');
    if (!widget) return;
    state.isOpen = false;
    widget.classList.remove('sp-open');
    resetWorkflow();
  }

  // ─── RESTORE STATE ──────────────────────────────────────────────────────────

  async function restoreTaskState() {
    try {
      const response  = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      const taskState = response?.state || null;

      if (!taskState) { renderProgressPanel(); return; }

      state.currentTaskState = taskState;
      state.goal             = taskState.goal || '';
      state.status           = normalizeStatus(taskState.status);
      state.statusMessage    = taskState.error || taskState.currentInstruction || taskState.status || 'Ready';

      if (taskState.goal && taskState.status === 'ACTIVE') {
        openWidget();
        const widget = document.getElementById('screenpilot-widget');
        if (widget) widget.querySelector('.sp-goal-input').value = taskState.goal;

        renderProgressPanel();
        if (!state.restoreTriggered) {
          state.restoreTriggered = true;
          setTimeout(() => {
            if (state.goal && !state.requestInFlight) {
              requestAnalysis('REANALYZE', 'restore-after-navigation');
            }
          }, 1200);
        }
        return;
      }

      renderProgressPanel();
    } catch (error) {
      setStatus('ERROR', 'Could not restore the current task state.');
    }
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  function normalizeStatus(status) {
    return status ? status.toUpperCase() : 'IDLE';
  }

  function getConfidenceLevel(confidence) {
    if (confidence < LOW_CONFIDENCE_THRESHOLD)    return 'low';
    if (confidence < WARNING_CONFIDENCE_THRESHOLD) return 'warning';
    return 'normal';
  }

  async function scrollIntoViewIfNeeded(element) {
    if (isInViewport(element)) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await wait(450);
  }

  function isInViewport(element) {
    const r = element.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  function isElementActionable(element) {
    if (!element || !DOMMatcher.isVisible(element)) return false;
    return !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true';
  }

  function isScreenPilotNode(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(el?.closest?.(
      '#screenpilot-widget, #screenpilot-highlight, #screenpilot-spotlight, #screenpilot-arrow, #screenpilot-bubble'
    ));
  }

  function isScreenPilotMutation(record) {
    return [record.target, ...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])]
      .filter(Boolean)
      .every(isScreenPilotNode);
  }

  function buildDefaultInstruction(targetText) {
    return targetText ? `Click "${targetText}"` : 'Follow the highlighted step';
  }

  function buildMissingElementMessage(targetElement) {
    if (!targetElement?.text) return 'Gemini did not identify a clear target on this screen.';
    return `I found the next step, but not the matching element for "${targetElement.text}".`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(...args) {
    if (DEBUG) console.log('[ScreenPilot]', ...args);
  }

  // ─── INIT ───────────────────────────────────────────────────────────────────

  function init() {
    console.log('[SP:LAUNCH] init() entered, readyState=', document.readyState, 'body=', !!document.body, 'url=', window.location.href);
    if (document.getElementById('screenpilot-widget')) {
      console.log('[SP:LAUNCH] init(): widget already in DOM, skipping init');
      return;
    }
    console.log('[SP:LAUNCH] init(): no existing widget, calling createWidget()');
    createWidget();
    document.addEventListener('click', handleDocumentClick, true);
    // Add input/focus/blur detection for dynamic content
    document.addEventListener('input', handleInputEvent, true);
    document.addEventListener('change', handleInputEvent, true);
    document.addEventListener('focusin', handleFocusEvent, true);
    document.addEventListener('focusout', handleFocusEvent, true);
    restoreTaskState();
    console.log('[Content] init() completed');
  }

  // ─── INPUT EVENT HANDLERS ─────────────────────────────────────────────
  function handleInputEvent(event) {
    if (!state.goal || !state.highlightedElement) return;
    // Check if user typed in the highlighted element
    if (state.highlightedElement.contains(event.target)) {
      console.log('[PageObserver] Input detected in highlighted element');
      triggerReanalysis('Input detected');
    }
  }

  function handleFocusEvent(event) {
    if (!state.goal || !state.highlightedElement) return;
    // Check if user focused/blurred the highlighted element
    if (state.highlightedElement.contains(event.target)) {
      const reason = event.type === 'focusin' ? 'Focus gained' : 'Focus lost';
      console.log('[PageObserver]', reason, 'on highlighted element');
      triggerReanalysis(reason);
    }
  }

  // Top-level message listener — must be outside init()
  console.log('[Content] registering runtime listener');
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Content] message received', message.type);
    // Only handle messages explicitly directed at the content script.
    // Do NOT call sendResponse for other types — background responses must not be intercepted.
    if (message.type === 'OPEN_WIDGET')  {
      openWidget();
      const widgetInDom = !!document.getElementById('screenpilot-widget');
      console.log('[SP:LAUNCH] OPEN_WIDGET handled, widgetInDom=', widgetInDom, 'state.isOpen=', state.isOpen);
      sendResponse({ success: true, widgetInDom });
      return false;
    }
    if (message.type === 'CLOSE_WIDGET') { closeWidget(); sendResponse({ success: true }); return false; }
    if (message.type === 'RUN_GOAL') {
      // Benchmark injection: open the widget and trigger analysis for the given goal.
      const goalInput = document.querySelector('#screenpilot-widget .sp-goal-input');
      if (!goalInput) {
        // Widget not yet open — open it first, then let the user interact,
        // or attempt to open + set goal after a brief delay.
        openWidget();
        setTimeout(() => {
          const inp = document.querySelector('#screenpilot-widget .sp-goal-input');
          if (inp && message.goal) {
            inp.value = message.goal;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, 200);
      } else {
        goalInput.value = message.goal || '';
        goalInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      sendResponse({ success: true });
      return false;
    }
    // Unknown type — do not respond, let the message pass through to the background.
    return false;
  });

  console.log('[SP:LAUNCH] content.js IIFE bottom, readyState=', document.readyState);
  if (document.readyState === 'loading') {
    console.log('[SP:LAUNCH] waiting for DOMContentLoaded before init()');
    document.addEventListener('DOMContentLoaded', init);
  } else {
    console.log('[SP:LAUNCH] DOM already ready, calling init() now');
    init();
  }
})();
