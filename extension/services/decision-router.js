// ScreenPilot v2 — Decision Router
//
// Layer Control System for the Local-First Hierarchical Architecture:
// 1. Fast Local Path (Deterministic DOMMatcher / exact match, threshold >= 0.85)
// 2. Small ML Model (UI Element Grounding & Ranking, threshold >= 0.70)
// 3. Reasoning fallback — Cloud LLM by default; Local Qwen is opt-in
//    (executionMode === 'local-qwen') and itself falls back to cloud on
//    any failure/timeout/unavailability, one attempt per provider, never
//    both directions. executionMode === 'cloud' never contacts Ollama.

import { UIGroundingService }     from './ui-grounding-service.js';
import { LocalQwenAdapter }       from '../providers/local-qwen-adapter.js';
import { VercelBackendAdapter }   from '../providers/vercel-backend-adapter.js';

import { GoalVerifier }      from './goal-verifier.js';

export const DETERMINISTIC_THRESHOLD = 0.85;
export const ML_GROUNDING_THRESHOLD  = 0.70;

export class DecisionRouter {
  /**
   * @param {object} [options]
   * @param {number} [options.deterministicThreshold]
   * @param {number} [options.mlGroundingThreshold]
   * @param {'cloud'|'local-qwen'} [options.executionMode] - L3 backend selection. Default 'cloud'.
   * @param {object} [options.localQwenAdapter]
   * @param {object} [options.cloudAdapter]
   */
  constructor({
    deterministicThreshold = DETERMINISTIC_THRESHOLD,
    mlGroundingThreshold  = ML_GROUNDING_THRESHOLD,
    executionMode          = 'cloud',
    localQwenAdapter       = null,
    cloudAdapter           = null
  } = {}) {
    this.deterministicThreshold = deterministicThreshold;
    this.mlGroundingThreshold  = mlGroundingThreshold;
    this.executionMode          = executionMode;
    this.localQwenAdapter       = localQwenAdapter ?? new LocalQwenAdapter();
    this.cloudAdapter           = cloudAdapter ?? new VercelBackendAdapter();
  }

  /**
   * Route a task goal through the 3-tier local hierarchy.
   *
   * @param {string} goal
   * @param {import('../shared/types/index.js').NormalizedPageState} pageState
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {object} [options.cloudContext] - Lazily-used context for an L3 cloud call.
   * @param {() => Promise<{image:string,mimeType:string}>} [options.cloudContext.getScreenshot] - Only invoked if cloud is actually called.
   * @param {object} [options.cloudContext.executionHistory]
   * @param {string[]} [options.cloudContext.clarifications]
   * @param {object[]} [options.cloudContext.pageControls]
   * @param {string} [options.cloudContext.requestId]
   * @returns {Promise<{ layer: 'deterministic'|'ml_grounding'|'local_qwen'|'cloud', planResponse: object, layer1Ms: number, layer2Ms: number, qwenMs: number, cloudMs: number, qwenFailureReason: string|null }>}
   */
  async route(goal, pageState, options = {}) {
    const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];

    // ── Layer 1: Fast Local Path (Deterministic Heuristic / Exact Label Match) ──
    const tL1Start = Date.now();
    const fastMatch = this._evalFastPath(goal, elements);
    const layer1Ms = Date.now() - tL1Start;

    if (fastMatch && fastMatch.score >= this.deterministicThreshold) {
      console.log(`[SP:DecisionRouter] Layer 1 FAST PATH matched (score=${fastMatch.score}):`, fastMatch.element.text || fastMatch.element.placeholder);
      console.log(`[SP:V2:DEBUG] layer=deterministic reason=exact_label_match candidateCount=${elements.length} confidence=${fastMatch.score}`);
      return {
        layer: 'deterministic',
        planResponse: this._buildPlanFromElement(goal, fastMatch.element, fastMatch.score, 'deterministic'),
        layer1Ms,
        layer2Ms: 0,
        qwenMs: 0,
        cloudMs: 0,
        qwenFailureReason: null
      };
    }

    // ── Layer 2: Small ML Grounding & Ranking Model ────────────────────────────
    const tL2Start = Date.now();
    const ranked = UIGroundingService.rankElements(goal, elements);
    const layer2Ms = Date.now() - tL2Start;

    if (ranked.length > 0 && ranked[0].score >= this.mlGroundingThreshold) {
      const top = ranked[0];
      console.log(`[SP:DecisionRouter] Layer 2 ML GROUNDING matched (score=${top.score}):`, top.element.text || top.element.placeholder);
      console.log(`[SP:V2:DEBUG] layer=ml_grounding reason=feature_vector_score candidateCount=${elements.length} confidence=${top.score}`);
      return {
        layer: 'ml_grounding',
        planResponse: this._buildPlanFromElement(goal, top.element, top.score, 'ml_grounding'),
        layer1Ms,
        layer2Ms,
        qwenMs: 0,
        cloudMs: 0,
        qwenFailureReason: null
      };
    }

    // ── Layer 3: reasoning fallback (Cloud default, Local Qwen opt-in) ─────────
    console.log(`[SP:DecisionRouter] Layer 3 invoked for goal: "${goal}" executionMode=${this.executionMode}`);
    console.log(`[SP:V2:DEBUG] layer=L3 reason=confidence_below_threshold candidateCount=${elements.length} executionMode=${this.executionMode}`);
    const l3 = await this._runLayer3(goal, pageState, elements, options);

    return { ...l3, layer1Ms, layer2Ms };
  }

  /**
   * L3: exactly one Qwen attempt (only when executionMode === 'local-qwen' and
   * Ollama reports available), then exactly one Cloud attempt as fallback/default.
   * Never retries a provider and never bounces back and forth between them.
   */
  async _runLayer3(goal, pageState, elements, options) {
    const { signal, cloudContext = {} } = options;
    let qwenMs = 0;
    let qwenFailureReason = null;

    if (this.executionMode === 'local-qwen') {
      const tAvailStart = Date.now();
      let avail;
      try {
        avail = await this.localQwenAdapter.checkAvailability();
      } catch (err) {
        avail = { available: false, reason: err?.message || 'availability_check_failed' };
      }
      console.log(`[SP:DecisionRouter] Layer 3 Qwen availability=${avail.available} (${Date.now() - tAvailStart}ms)`);

      if (avail.available) {
        const tQwenStart = Date.now();
        try {
          const planResponse = await this.localQwenAdapter.plan({
            schemaVersion: '1',
            goal,
            page: { url: pageState.url, title: pageState.title },
            elements
          }, { signal });
          qwenMs = Date.now() - tQwenStart;
          // LocalQwenAdapter never throws on failure (timeout, unreachable, bad
          // JSON, etc. all resolve a { result: 'FAILED', errorCode, error } shape
          // — see local-qwen-adapter.js's _networkFailure). A resolved FAILED
          // result is therefore just as much a "Qwen failed" signal as a thrown
          // exception and must trigger the same one-time cloud fallback.
          if (planResponse?.result === 'FAILED') {
            qwenFailureReason = planResponse.error || planResponse.errorCode || 'qwen_failed';
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN resolved FAILED (${qwenFailureReason}, ${qwenMs}ms) — falling back to cloud once`);
          } else {
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN succeeded (${qwenMs}ms)`);
            return { layer: 'local_qwen', planResponse, qwenMs, cloudMs: 0, qwenFailureReason: null };
          }
        } catch (err) {
          // Defense-in-depth: a custom/mock adapter (or a future code path) might
          // still throw. Treated identically to a resolved FAILED result above.
          qwenMs = Date.now() - tQwenStart;
          qwenFailureReason = err?.message || 'qwen_error';
          console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN threw (${qwenFailureReason}, ${qwenMs}ms) — falling back to cloud once`);
        }
      } else {
        qwenFailureReason = avail.reason || 'ollama_unavailable';
        console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN unavailable (${qwenFailureReason}) — using cloud`);
      }
    }

    // Cloud: the default L3 (executionMode==='cloud'), or the fallback after a
    // failed/unavailable Qwen attempt. Screenshot is fetched here, lazily —
    // only paid for when a cloud call is actually about to happen.
    const tCloudStart = Date.now();
    const screenshot = cloudContext.getScreenshot ? await cloudContext.getScreenshot() : null;
    const cloudRequest = {
      schemaVersion: '1',
      requestId: cloudContext.requestId,
      goal,
      page: {
        url: pageState.url,
        title: pageState.title,
        screenshot: { image: screenshot?.image, mimeType: screenshot?.mimeType }
      },
      ...(cloudContext.executionHistory && { executionHistory: cloudContext.executionHistory }),
      ...(cloudContext.clarifications?.length && { clarifications: cloudContext.clarifications }),
      ...(cloudContext.pageControls?.length && { pageControls: cloudContext.pageControls })
    };
    const planResponse = await this.cloudAdapter.plan(cloudRequest, { signal });
    const cloudMs = Date.now() - tCloudStart;
    console.log(`[SP:DecisionRouter] Layer 3 CLOUD resolved (${cloudMs}ms)`);

    return { layer: 'cloud', planResponse, qwenMs, cloudMs, qwenFailureReason };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _evalFastPath(goal, elements) {
    const normGoal = goal.trim().toLowerCase();
    if (!normGoal || !elements.length) return null;

    const targetObject = GoalVerifier.extractTargetObject(goal);

    for (const el of elements) {
      if (!el.visible || el.enabled === false) continue;
      const normText  = (el.text || '').trim().toLowerCase();
      const normPlace = (el.placeholder || '').trim().toLowerCase();
      const normAria  = (el.ariaLabel || '').trim().toLowerCase();

      // 1. Exact string match or click verb prefix
      if (normText && (normText === normGoal || normGoal === `click ${normText}` || normGoal === `click '${normText}'`)) {
        return { element: el, score: 0.98 };
      }
      // 2. Action verb prefix stripping match (NLP-lite target object match)
      if (targetObject && targetObject.length >= 2) {
        if (normText === targetObject || normPlace === targetObject || normAria === targetObject) {
          return { element: el, score: 0.95 };
        }
      }
      if (normPlace && (normPlace === normGoal || normGoal === `fill ${normPlace}` || normGoal === `search ${normPlace}`)) {
        return { element: el, score: 0.95 };
      }
      if (normAria && (normAria === normGoal || normGoal === `click ${normAria}`)) {
        return { element: el, score: 0.92 };
      }
    }
    return null;
  }

  _buildPlanFromElement(goal, element, confidence, layer) {
    const isInput = ['textbox', 'combobox', 'search'].includes(element.role) || ['input', 'textarea'].includes(element.tag);
    const label   = element.text || element.placeholder || element.ariaLabel || goal;
    const action  = isInput ? 'fill_form' : 'navigate';

    const step = {
      id: 1,
      description: `${isInput ? 'Fill' : 'Click'} '${label}'`,
      intent: `${isInput ? 'fill' : 'click'}_${label}`,
      phase: action,
      completionCondition: 'dom_change',
      targetElement: {
        text: label,
        type: isInput ? 'input' : 'button',
        intent: label,
        elementId: element.id,
        region: element.region ?? null
      },
      // Provisional default — corrected centrally in v2-task.js's plan-loop enrichment
      // step, which looks the resolved element back up in PageStateService's element
      // list (by elementId) and derives urlChanges from its actual tag/href. Do NOT
      // add href-sniffing logic here too; that would duplicate the one true source.
      expectedPageState: { urlChanges: false }
    };

    return {
      schemaVersion: '1',
      result: 'OK',
      state: 'planned',
      plannerSummary: `[Layer: ${layer}] Resolved target element '${label}' with confidence ${confidence}`,
      confidence,
      plan: {
        goalType: 'action',
        confidence,
        steps: [step]
      },
      providerMetadata: { provider: layer, model: 'local-heuristic', latencyMs: 2 }
    };
  }
}
