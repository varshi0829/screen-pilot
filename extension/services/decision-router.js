// ScreenPilot v2 — Decision Router
//
// Layer Control System for the Local-First Hierarchical Architecture:
// 1. Fast Local Path (Deterministic DOMMatcher / exact match, threshold >= 0.85)
// 2. Small ML Model (UI Element Grounding & Ranking, threshold >= 0.70)
// 3. Reasoning fallback — Cloud LLM by default; when executionMode ===
//    'local-qwen' (the existing local-first opt-in), L3 is a ROUTER that
//    picks exactly ONE local provider for the cycle — Moondream and Qwen are
//    never both invoked in the same cycle:
//      a. If L2's own ranking (`ranked`, already computed above) found ANY
//         candidate element at all (even below the 0.70 threshold), there is
//         a viable textual/DOM candidate — the local TEXT reasoner (Qwen) is
//         used.
//      b. Only when `ranked` is empty — the DOM/text representation
//         genuinely offers nothing to reason over — is local Moondream
//         VISUAL PERCEPTION used. It only ever points at an element from the
//         current page state's own element list; it is not a planner. A
//         validated pick is wrapped into a plan via _buildPlanFromElement,
//         the exact same helper L1/L2 use.
//      c. Whichever ONE of (a)/(b) was chosen, if it's unavailable, fails, or
//         (vision only) names an elementId that doesn't actually exist in
//         the current page state, the router falls straight through to
//         Cloud — it does NOT then try the other local provider.
//    executionMode === 'cloud' never contacts Ollama at all.
//
// TASK PROGRESS
// -------------
// Every layer here grounds the ORIGINAL goal, and the goal text never changes
// between replans. Grounding is therefore a pure function of (goal, elements):
// given the same candidates it necessarily returns the same element, including
// one that was just acted on successfully. Progress across cycles comes from
// the other input — the candidate set — which route() narrows using
// `settledSteps`: this task's own completed actions whose effect IS the state
// now being routed against. Their targets are, by definition, not the next
// action, so they are withheld before any scoring happens.
//
// Nothing here knows which site it is looking at: the projection is computed
// from the task's own action history plus the page's own before/after state
// fingerprints, both of which already existed for the dedup guard. The dedup
// guard still runs downstream, unchanged, as the safety net — the difference
// is that the planner no longer needs it to notice the repeat, because the
// repeat is no longer proposed.

import { UIGroundingService }     from './ui-grounding-service.js';
import { LocalQwenAdapter }       from '../providers/local-qwen-adapter.js';
import { LocalVisionAdapter }     from '../providers/local-vision-adapter.js';
import { VercelBackendAdapter }   from '../providers/vercel-backend-adapter.js';

import { SanitizingAdapter }     from '../providers/sanitizing-adapter.js';
import { TokenVault }            from '../lib/pii-vault.js';
import { logEvent }              from '../lib/sp-logger.js';

import { GoalVerifier }      from './goal-verifier.js';

export const DETERMINISTIC_THRESHOLD = 0.85;
export const ML_GROUNDING_THRESHOLD  = 0.70;
// SIH 2026 demo latency fix: cap on how many L2-ranked candidates get sent to
// Moondream (see _runLayer3) — smaller prompt, faster local-vision inference,
// without changing L1/L2's own matching/thresholds at all.
export const VISION_CANDIDATE_LIMIT  = 10;
// Cap on how many L2-ranked candidates get sent to Qwen (see _runLayer3).
// Previously Qwen received `elements.slice(0, 25)` in raw DOM order, which
// could silently exclude the actually-relevant element on a real page with
// many candidates ahead of it in DOM order (e.g. a language-link grid before
// a page's search box), forcing Qwen to choose among irrelevant leftovers.
// Sending the top-N by L2's own relevance ranking instead fixes that
// generically — no site/phrase-specific logic, just reusing the ranking L2
// already computed.
export const QWEN_CANDIDATE_LIMIT    = 25;
// Phase 6: a Qwen answer below this confidence is not trusted — it is treated
// exactly like any other local-provider failure and follows the existing
// fallback (straight to Cloud; never to the other local provider). Same bar
// L2 grounding has to clear.
export const QWEN_MIN_CONFIDENCE     = 0.70;
// Minimum lead the top candidate must hold over the runner-up for L2 to commit
// on its own. Below it, several candidates are covering the goal's vocabulary
// equally well and the winner is decided by sort order — measured at exactly
// 0.000 across three sibling controls whose labels differed only in a word the
// goal never mentioned. Kept deliberately small: this criterion exists to catch
// near-ties, NOT to second-guess a clear lead (measured clear cases: 0.480,
// 0.690, 0.760, 0.880, 0.960 — all well above it and all still deterministic).
export const AMBIGUITY_MARGIN        = 0.05;
// How much of the winner's score the runner-up must hold to count as genuinely
// in contention. Used only together with unmatched goal vocabulary — see
// _assessAmbiguity. Measured: 0.34 where the lexical winner was the wrong
// element, 0.22 and below where it was right.
export const RIVAL_SHARE             = 0.30;
// Margin at which the ranking is treated as having genuinely discriminated.
// Above it, an absent goal word is not evidence of a contest — there is a
// clear winner regardless. Measured separation is wide: the cases that must
// still escalate sit at 0.030 and 0.000, the ones that must run deterministically
// at 0.330 and above.
export const DECISIVE_MARGIN         = 0.15;
// Confidence reported when a sole unlabeled interactive candidate is resolved
// structurally (see _findSoleUnlabeledInteractiveCandidate) after visual
// perception named no usable element. This is not a model score — nothing
// scored or perceived this pick — so it is kept below LocalVisionAdapter's
// own default (0.75) rather than implying equivalent certainty; it exists
// only so the resulting plan carries a plausible, ordinary confidence value.
export const SOLE_UNLABELED_CANDIDATE_CONFIDENCE = 0.6;
// Same interactive roles/tags PageStateService's own extraction selector
// already treats as "an interactive control" (see its querySelectorAll
// selector) — reused here rather than inventing a second taxonomy, so
// "structurally actionable" means exactly what it already means everywhere
// else in this pipeline.
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'textbox', 'combobox']);
const INTERACTIVE_TAGS  = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);

// Function words that mark where a goal stops describing the ACTION and starts
// stating the VALUE. These are English grammar, not vocabulary: they carry no
// meaning of their own, name no site, and map to no synonym. The same words are
// already treated as structural elsewhere — every one of them is in
// ui-grounding-service's stopWords list, i.e. the tokens L2 refuses to score on
// precisely because they describe relationships rather than things.
//
// Two shapes, distinguished by which side of the marker the value sits on:
//   "... for X" / "... to X" / "... with X"   -> the value TRAILS the marker
//   "<verb> X into <target>"                  -> the value PRECEDES the marker
const VALUE_TRAILS_MARKERS   = ['for', 'to', 'with'];
const VALUE_PRECEDES_MARKERS = ['into'];

/**
 * Extract the value a goal is asking to be entered, if it states one.
 *
 * Deterministic and structural: it reads where the goal's own function words
 * put the payload, never what the payload means. A goal that states no value
 * yields '' — this guesses nothing, so "create a new repo" stays valueless and
 * the workflow is free to stop at the form and ask, rather than inventing one.
 *
 * Callers must only apply this to a target that RECEIVES a value. That gate is
 * what keeps ordinary navigation safe: "go to settings" trails a marker too,
 * but resolves to a link, so no value is ever taken from it.
 *
 * @param {string} goal
 * @param {string} [targetLabel] - The control's own accessible name. A payload
 *   identical to it is rejected: that is the label/value conflation this
 *   exists to prevent, not a value the user asked for.
 * @returns {string}
 */
export function extractRequestedValue(goal, targetLabel = '') {
  const words = String(goal ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return '';

  const bare = words.map(w => w.toLowerCase().replace(/[.,!?;:]+$/, ''));
  let payload = '';

  const precedesAt = bare.findIndex(w => VALUE_PRECEDES_MARKERS.includes(w));
  if (precedesAt > 1) {
    // "<verb> <value> into <target>" — drop the leading action verb.
    payload = words.slice(1, precedesAt).join(' ');
  } else {
    let trailsAt = -1;
    for (let i = 0; i < bare.length - 1; i++) {
      if (VALUE_TRAILS_MARKERS.includes(bare[i])) trailsAt = i;
    }
    if (trailsAt >= 0) payload = words.slice(trailsAt + 1).join(' ');
  }

  payload = payload.replace(/^(the|a|an)\s+/i, '').trim();
  if (!payload) return '';

  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (norm(payload) === norm(targetLabel)) return '';

  return payload;
}

export class DecisionRouter {
  /**
   * @param {object} [options]
   * @param {number} [options.deterministicThreshold]
   * @param {number} [options.mlGroundingThreshold]
   * @param {'cloud'|'local-qwen'} [options.executionMode] - L3 backend selection. Default 'cloud'.
   * @param {object} [options.localQwenAdapter]
   * @param {object} [options.localVisionAdapter]
   * @param {object} [options.cloudAdapter]
   */
  constructor({
    deterministicThreshold = DETERMINISTIC_THRESHOLD,
    mlGroundingThreshold  = ML_GROUNDING_THRESHOLD,
    executionMode          = 'cloud',
    localQwenAdapter       = null,
    localVisionAdapter    = null,
    cloudAdapter           = null
  } = {}) {
    this.deterministicThreshold = deterministicThreshold;
    this.mlGroundingThreshold  = mlGroundingThreshold;
    this.executionMode          = executionMode;
    // Phase 6: defaults are wrapped in SanitizingAdapter (one shared per-router
    // vault) so a router built without injected adapters can never send raw PII
    // to any model. v2-task.js injects its own already-wrapped adapters.
    const defaultVault = new TokenVault();
    this.localQwenAdapter       = localQwenAdapter ?? new SanitizingAdapter(new LocalQwenAdapter(), { vault: defaultVault });
    this.localVisionAdapter    = localVisionAdapter ?? new SanitizingAdapter(new LocalVisionAdapter(), { vault: defaultVault });
    this.cloudAdapter           = cloudAdapter ?? new SanitizingAdapter(new VercelBackendAdapter(), { vault: defaultVault });
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
   * @param {object[]} [options.completedSteps] - This task's own completed-step
   *   history (session order, oldest first).
   * @param {object[]} [options.settledSteps] - The subset of completedSteps whose
   *   own post-action state IS the state being routed against right now (see
   *   the TASK PROGRESS note on the class above). Supplied by the caller, which
   *   owns the session and the page snapshot; derived fresh every cycle and
   *   never persisted, so it cannot go stale.
   * @param {object[]} [options.unsatisfiedRequirements] - The goal's own
   *   goalCompletionCriteria.successSignals entries not yet historically
   *   satisfied (per the caller's requirementProgress) — same shape as
   *   successSignals ({type, text} or {type, urlPattern}), computed entirely
   *   by the caller. Optional and additive: omitted, this router behaves
   *   exactly as before. Consulted only by structural continuation (see
   *   _resolveActionContinuation) to avoid treating a form's submit control
   *   as the next action while the goal itself still needs something else on
   *   the same page — see that method's own doc comment.
   * @returns {Promise<{ layer: 'deterministic'|'ml_grounding'|'local_qwen'|'cloud', planResponse: object, layer1Ms: number, layer2Ms: number, qwenMs: number, cloudMs: number, qwenFailureReason: string|null }>}
   */
  async route(goal, pageState, options = {}) {
    const elements = Array.isArray(pageState?.elements) ? pageState.elements : [];
    const completedSteps = Array.isArray(options.completedSteps) ? options.completedSteps : [];
    const settledSteps   = Array.isArray(options.settledSteps) ? options.settledSteps : [];

    // A clarification is the user answering "which one did you mean?" — it is
    // the most direct statement of intent available, and until now only the
    // cloud tier ever saw it. Locally the same tie was re-derived from the
    // unchanged goal, so answering changed nothing and the question could be
    // asked again. Folding the answer into the text being grounded is all the
    // local path needs: the user's own words, used as words.
    //
    // Grounding only. The original goal still drives value extraction, so a
    // clarification naming a control can never be mistaken for a payload.
    const clarifications = Array.isArray(options.cloudContext?.clarifications)
      ? options.cloudContext.clarifications.filter(Boolean)
      : [];
    const groundingIntent = clarifications.length
      ? `${goal} ${clarifications.join(' ')}`
      : goal;
    if (clarifications.length) {
      console.log(`[SP:DecisionRouter] Grounding with ${clarifications.length} clarification(s) folded into the intent`);
    }

    // ── Task progress projection ───────────────────────────────────────────────
    // The goal text is immutable across replans, so grounding it against an
    // unchanged candidate set is a pure function — it necessarily re-selects
    // the element that was just acted on. What changes between cycles is not
    // the goal but how much of it is already DONE, and that is exactly what
    // `settledSteps` expresses: actions whose effect is the state we are
    // looking at. Those targets are, by definition, not the NEXT action, so
    // they are withheld from the candidate set here — before any scoring.
    //
    // This changes only WHICH candidates the layers see, never how any layer
    // scores them: L1/L2 semantics, thresholds and the routing order are
    // untouched. It is also self-correcting rather than sticky — the caller
    // only reports a step as settled while the page still matches that step's
    // own recorded post-action state, so a control that legitimately needs
    // acting on again (its effect having been superseded) reappears as a
    // candidate automatically.
    const candidates = settledSteps.length
      ? elements.filter((el) => !this._isSettledTarget(el, settledSteps))
      : elements;
    if (settledSteps.length) {
      console.log(`[SP:DecisionRouter] Task progress: ${settledSteps.length} settled action(s) — ${elements.length - candidates.length} target(s) withheld, ${candidates.length} candidate(s) remain`);
    }

    // ── Layer 1: Fast Local Path (Deterministic Heuristic / Exact Label Match) ──
    const tL1Start = Date.now();
    const fastMatch = this._evalFastPath(groundingIntent, candidates);
    const layer1Ms = Date.now() - tL1Start;

    if (fastMatch && fastMatch.score >= this.deterministicThreshold) {
      const requiredGate = this._resolveRequiredFieldGate(goal, elements, fastMatch.element);
      if (requiredGate) {
        console.log(`[SP:DecisionRouter] Layer 1 target's form has an unmet required field — redirecting to elementId=${requiredGate.plan.steps[0].targetElement.elementId}`);
        return { layer: 'ml_grounding', planResponse: requiredGate, layer1Ms, layer2Ms: 0, qwenMs: 0, cloudMs: 0, qwenFailureReason: null };
      }
      console.log(`[SP:DecisionRouter] Layer 1 FAST PATH matched (score=${fastMatch.score}):`, fastMatch.element.text || fastMatch.element.placeholder);
      console.log(`[SP:V2:DEBUG] layer=deterministic reason=exact_label_match candidateCount=${candidates.length} confidence=${fastMatch.score}`);
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
    const assessment = UIGroundingService.assessGrounding(groundingIntent, candidates);
    const ranked = assessment.ranked;
    const layer2Ms = Date.now() - tL2Start;

    // Clearing the score threshold says the winner matched well. It does NOT
    // say the evidence was good enough to commit on — see assessGrounding.
    // When it isn't, L2 hands the decision to the semantic tier below instead
    // of acting on a confident guess. Thresholds and scoring are unchanged;
    // this only decides whether L2 is entitled to STOP here.
    // Only meaningful when L2 actually had a qualifying answer. Below the
    // threshold it was never going to commit, so the cycle is an ordinary
    // below-confidence escalation and keeps the ordinary L3 failure semantics
    // — "could not choose between qualifying candidates" and "had no
    // qualifying candidate" are different situations and must not be conflated.
    const clearsThreshold = ranked.length > 0 && ranked[0].score >= this.mlGroundingThreshold;
    const insufficientEvidence = clearsThreshold ? this._assessAmbiguity(assessment) : null;

    if (clearsThreshold && !insufficientEvidence) {
      const top = ranked[0];
      const requiredGate = this._resolveRequiredFieldGate(goal, elements, top.element);
      if (requiredGate) {
        console.log(`[SP:DecisionRouter] Layer 2 target's form has an unmet required field — redirecting to elementId=${requiredGate.plan.steps[0].targetElement.elementId}`);
        return { layer: 'ml_grounding', planResponse: requiredGate, layer1Ms, layer2Ms, qwenMs: 0, cloudMs: 0, qwenFailureReason: null };
      }
      console.log(`[SP:DecisionRouter] Layer 2 ML GROUNDING matched (score=${top.score}):`, top.element.text || top.element.placeholder);
      console.log(`[SP:V2:DEBUG] layer=ml_grounding reason=feature_vector_score candidateCount=${candidates.length} confidence=${top.score}`);
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

    // ── Structural continuation of the settled action ──────────────────────────
    // Lexical grounding has now failed to find the next action. Before paying
    // for a reasoning model, check whether the state itself already determines
    // it: an interaction that a settled action STARTED but did not finish has
    // a continuation control defined by standard HTML, reachable without
    // understanding the page's wording at all (see _resolveActionContinuation).
    // Placed after L2 deliberately — a confident lexical match is still the
    // better answer when one exists, and this must never pre-empt it.
    const continuation = this._resolveActionContinuation(elements, settledSteps, options.unsatisfiedRequirements);
    if (continuation) {
      console.log(`[SP:DecisionRouter] Structural continuation of settled action -> elementId=${continuation.plan.steps[0].targetElement.elementId} (no model invoked)`);
      return { layer: 'ml_grounding', planResponse: continuation, layer1Ms, layer2Ms, qwenMs: 0, cloudMs: 0, qwenFailureReason: null };
    }

    // ── Layer 3: reasoning fallback (Cloud default, Local Qwen opt-in) ─────────
    const l3Reason = insufficientEvidence
      ? `lexical_evidence_insufficient(${insufficientEvidence})`
      : 'confidence_below_threshold';
    // The goal is user text: it is only ever logged through the PII-safe logger.
    logEvent('layer3_invoked', { goal, executionMode: this.executionMode, reason: l3Reason, candidateCount: candidates.length });
    console.log(`[SP:V2:DEBUG] layer=L3 reason=${l3Reason} candidateCount=${candidates.length} topScore=${assessment.topScore} margin=${assessment.margin.toFixed(3)} executionMode=${this.executionMode}`);
    const l3 = await this._runLayer3(groundingIntent, pageState, candidates, options, ranked);

    // Escalation on EVIDENCE means L2 could not tell its candidates apart — the
    // tie is real, not a scoring artifact. If the reasoning tier then fails,
    // there is no basis to choose, and picking the highest-sorted of several
    // equally-scoring controls is a coin flip wearing a confidence score: on a
    // menu of sibling actions it is as likely to trigger the wrong irreversible
    // one as the right one. Unresolved ambiguity is reported as such, which
    // routes into the clarification flow this app already has, instead of being
    // laundered into a deterministic-looking answer.
    //
    // Only for this escalation reason. A genuine below-threshold miss has no
    // tied candidates to be unsafe about and is unchanged.
    if (insufficientEvidence && l3?.planResponse?.result !== 'OK') {
      const options = ranked.slice(0, 5)
        .map((r) => r.element.text || r.element.ariaLabel || r.element.placeholder || r.element.id)
        .filter(Boolean);
      console.log(`[SP:DecisionRouter] Reasoning tier failed after an evidence escalation (${insufficientEvidence}) — reporting unresolved ambiguity rather than guessing among ${options.length} candidate(s)`);
      return {
        layer: l3.layer,
        planResponse: {
          schemaVersion: '1',
          result: 'NEEDS_USER',
          state: 'ambiguous',
          confidence: 0,
          plannerSummary: options.length
            ? `Several controls match this goal equally well: ${options.join(', ')}. Which one did you mean?`
            : 'Could not determine the next action from this page.',
          providerMetadata: { provider: l3.layer, model: 'none', latencyMs: 0 }
        },
        layer1Ms, layer2Ms,
        qwenMs: l3.qwenMs ?? 0, cloudMs: l3.cloudMs ?? 0,
        qwenFailureReason: l3.qwenFailureReason ?? null
      };
    }

    return { ...l3, layer1Ms, layer2Ms };
  }

  /**
   * L3 router: picks exactly ONE local provider per cycle — Moondream and
   * Qwen are never both invoked in the same cycle. `ranked` (L2's own
   * scoring, already computed by the caller) decides which: any candidate
   * at all (even below L2's own threshold) means Qwen (text) is used; zero
   * candidates means the DOM/text representation has nothing to reason
   * over, so Moondream (visual perception) is used instead. Whichever one
   * is chosen, on failure/unavailability the router falls straight through
   * to Cloud — it does not then try the other local provider. Never retries
   * a provider.
   */
  async _runLayer3(goal, pageState, elements, options, ranked = []) {
    const { signal, cloudContext = {} } = options;
    let qwenMs = 0;
    let qwenFailureReason = null;
    let visionMs = 0;
    let visionFailureReason = null;
    // Fetched at most once and reused by whichever of local-vision/cloud
    // ends up needing it — never captured twice for a single planning cycle.
    let screenshot = null;
    const getScreenshotOnce = async () => {
      if (!screenshot) {
        screenshot = cloudContext.getScreenshot ? await cloudContext.getScreenshot() : null;
      }
      return screenshot;
    };

    // Router decision: a viable textual/DOM candidate exists whenever L2's
    // own ranking found ANY element at all (score > 0.05, L2's own filter
    // floor) — even if none cleared L2's 0.70 confidence threshold. That is
    // the signal that text-based reasoning (Qwen) has something to work
    // with; its absence is the signal that only visual perception
    // (Moondream) could possibly help.
    const hasViableTextCandidates = ranked.length > 0;
    if (hasViableTextCandidates) {
      const topCandidates = ranked.slice(0, 5)
        .map((r) => `${r.element.id}(${(r.element.text || r.element.ariaLabel || r.element.placeholder || '').slice(0, 40)}):${r.score.toFixed(3)}`)
        .join(', ');
      console.log(`[SP:DecisionRouter] Layer 3 top candidates: ${topCandidates}`);
    }

    if (this.executionMode === 'local-qwen' && !hasViableTextCandidates) {
      // Local visual PERCEPTION (Moondream): chosen only when the DOM/text
      // representation offered zero candidates. LocalVisionAdapter.plan()
      // returns a minimal perception result ({elementId, action, confidence,
      // reason}), never a plan — it is not a second planner. The elementId
      // is only ever trusted after being validated here against the CURRENT
      // page-state element list; an elementId that isn't a real,
      // currently-known element is treated exactly like a failure and falls
      // through to Cloud (NOT to Qwen — see class-level router comment).
      const tVisionAvailStart = Date.now();
      let visionAvail;
      try {
        visionAvail = await this.localVisionAdapter.checkAvailability();
      } catch (err) {
        visionAvail = { available: false, reason: err?.message || 'availability_check_failed' };
      }
      console.log(`[SP:DecisionRouter] Layer 3 router=vision (no text candidates) Moondream availability=${visionAvail.available} (${Date.now() - tVisionAvailStart}ms)`);

      if (visionAvail.available) {
        const tVisionStart = Date.now();
        try {
          const shot = await getScreenshotOnce();
          const perception = await this.localVisionAdapter.plan({
            schemaVersion: '1',
            goal,
            page: { url: pageState.url, title: pageState.title, screenshot: shot },
            elements
          }, { signal });
          visionMs = Date.now() - tVisionStart;

          if (perception?.result === 'FAILED') {
            visionFailureReason = perception.error || perception.errorCode || 'vision_failed';
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION resolved FAILED (${visionFailureReason}, ${visionMs}ms) — falling back to cloud`);
          } else {
            // Grounding/safety gate: Moondream may only ever point at an
            // element PageStateService actually extracted this cycle. Any
            // other id (invented, stale, or simply absent) is unusable —
            // never trusted, never executed.
            const resolvedElement = elements.find((el) => el.id === perception.elementId);
            if (!resolvedElement) {
              visionFailureReason = 'invalid_element_id';
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION named an unknown/missing elementId="${perception.elementId}" — rejected, checking for a sole unlabeled interactive candidate before falling back to cloud`);
              // Perception ran and named nothing usable — before paying for
              // Cloud, check whether the page state itself already resolves
              // this deterministically: if exactly one candidate is an
              // unlabeled interactive control (the same generic shape a
              // visually-only element has), that is almost certainly what
              // perception was trying and failing to name. Two or more such
              // candidates is genuine ambiguity — unchanged, still Cloud.
              const soleCandidate = this._findSoleUnlabeledInteractiveCandidate(elements);
              if (soleCandidate) {
                console.log(`[SP:DecisionRouter] Layer 3 sole unlabeled interactive candidate resolved structurally -> elementId=${soleCandidate.id} (no model invoked)`);
                return {
                  layer: 'local_vision',
                  planResponse: this._buildPlanFromElement(goal, soleCandidate, SOLE_UNLABELED_CANDIDATE_CONFIDENCE, 'local_vision'),
                  qwenMs, visionMs, cloudMs: 0, qwenFailureReason: null, visionFailureReason: null
                };
              }
            } else {
              console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION succeeded (${visionMs}ms) elementId=${perception.elementId}`);
              // TEMPORARY DEBUG — remove after the SIH demo recording. Fires
              // only on this exact success path: the local vision provider
              // (Moondream) was actually invoked, returned a result, and that
              // result resolved to a real element — not a guess/inference.
              console.log(`SP LOCAL VISION → Moondream (${visionMs}ms) elementId=${perception.elementId} confidence=${perception.confidence ?? 'n/a'}`);
              return {
                layer: 'local_vision',
                planResponse: this._buildPlanFromElement(goal, resolvedElement, perception.confidence ?? 0.75, 'local_vision'),
                qwenMs, visionMs, cloudMs: 0, qwenFailureReason: null, visionFailureReason: null
              };
            }
          }
        } catch (err) {
          visionMs = Date.now() - tVisionStart;
          visionFailureReason = err?.message || 'vision_error';
          console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION threw (${visionFailureReason}, ${visionMs}ms) — falling back to cloud`);
        }
      } else {
        visionFailureReason = visionAvail.reason || 'moondream_unavailable';
        console.log(`[SP:DecisionRouter] Layer 3 LOCAL VISION unavailable (${visionFailureReason}) — falling back to cloud`);
      }
    } else if (this.executionMode === 'local-qwen' && hasViableTextCandidates) {
      // Local Qwen (text planner): chosen whenever L2 found at least one
      // candidate to reason over. On failure/unavailability, falls straight
      // to Cloud — NOT to Moondream (see class-level router comment).
      const tAvailStart = Date.now();
      let avail;
      try {
        avail = await this.localQwenAdapter.checkAvailability();
      } catch (err) {
        avail = { available: false, reason: err?.message || 'availability_check_failed' };
      }
      console.log(`[SP:DecisionRouter] Layer 3 router=qwen (${ranked.length} text candidate(s)) Qwen availability=${avail.available} (${Date.now() - tAvailStart}ms)`);

      if (avail.available) {
        const tQwenStart = Date.now();
        try {
          // Reuse the SAME ranking L2 already computed a moment ago (no
          // extra scoring pass) instead of Qwen's own raw DOM-order slice —
          // the actually-relevant element must not be excluded from Qwen's
          // candidate window just because it appears late in the DOM.
          const qwenElements = ranked.length
            ? ranked.slice(0, QWEN_CANDIDATE_LIMIT).map((r) => r.element)
            : elements;
          const planResponse = await this.localQwenAdapter.plan({
            schemaVersion: '1',
            goal,
            page: { url: pageState.url, title: pageState.title },
            elements: qwenElements,
            // What this task has already done. _buildQwenPrompt has always
            // rendered a History line from this field, but nothing ever
            // supplied it locally — so the one tier whose whole job is
            // semantic reasoning was reasoning about a multi-step task with
            // no idea which steps were already done, and could only re-derive
            // the same first action. Same structure the cloud tier receives.
            ...(cloudContext.executionHistory && { executionHistory: cloudContext.executionHistory })
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
          } else if ((qwenFailureReason = this._qwenUnusableReason(planResponse, qwenElements))) {
            // Phase 6: an OK-shaped answer that can't be trusted (unknown
            // elementId, or too little confidence) is a local-provider
            // failure like any other: straight to Cloud, never to Moondream.
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN result unusable (${qwenFailureReason}, ${qwenMs}ms) — falling back to cloud once`);
          } else {
            const step = planResponse?.plan?.steps?.[0];
            const t = step?.targetElement || {};
            // The value is restored user data by now (SanitizingAdapter puts real
            // emails/phones back) — it is only ever reported as present/absent.
            // The line below keeps its exact prefix: eval/lib/metrics.mjs counts it.
            console.log(`[SP:DecisionRouter] Layer 3 LOCAL QWEN succeeded (${qwenMs}ms) elementId=${t.elementId ?? 'n/a'} phase=${step?.phase ?? 'n/a'}`);
            logEvent('layer3_qwen_ok', { elementId: t.elementId ?? null, phase: step?.phase ?? null, hasValue: !!t.value });
            return { layer: 'local_qwen', planResponse, qwenMs, visionMs, cloudMs: 0, qwenFailureReason: null, visionFailureReason };
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

    // Cloud: the default L3 (executionMode==='cloud'), or the fallback after
    // whichever single local provider the router chose has failed/been
    // unavailable. Screenshot is fetched here, lazily — only paid for when a
    // cloud call is actually about to happen (or reused from the
    // local-vision attempt above).
    const tCloudStart = Date.now();
    const shotForCloud = await getScreenshotOnce();
    const cloudRequest = {
      schemaVersion: '1',
      requestId: cloudContext.requestId,
      goal,
      page: {
        url: pageState.url,
        title: pageState.title,
        screenshot: { image: shotForCloud?.image, mimeType: shotForCloud?.mimeType }
      },
      ...(cloudContext.executionHistory && { executionHistory: cloudContext.executionHistory }),
      ...(cloudContext.clarifications?.length && { clarifications: cloudContext.clarifications }),
      ...(cloudContext.pageControls?.length && { pageControls: cloudContext.pageControls })
    };
    const planResponse = await this.cloudAdapter.plan(cloudRequest, { signal });
    const cloudMs = Date.now() - tCloudStart;
    console.log(`[SP:DecisionRouter] Layer 3 CLOUD resolved (${cloudMs}ms)`);

    return { layer: 'cloud', planResponse, qwenMs, visionMs, cloudMs, qwenFailureReason, visionFailureReason };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Why a non-FAILED Qwen plan can't be trusted, or null when it can. Qwen may
   * only ever point at an element it was offered from the CURRENT page state, and
   * must be confident enough. (A "finish" answer names no element, so only its
   * confidence is checked.)
   *
   * @param {object} planResponse
   * @param {object[]} elements - the candidates Qwen was offered (a subset of the current page state)
   * @returns {'invalid_element_id'|'low_confidence'|null}
   */
  _qwenUnusableReason(planResponse, elements) {
    if (planResponse?.state !== 'complete') {
      const elementId = planResponse?.plan?.steps?.[0]?.targetElement?.elementId;
      if (!elementId || !elements.some((el) => el.id === elementId)) return 'invalid_element_id';
    }
    const confidence = planResponse?.confidence;
    if (typeof confidence === 'number' && confidence < QWEN_MIN_CONFIDENCE) return 'low_confidence';
    return null;
  }

  /**
   * Does this element correspond to the target of one of the given steps?
   *
   * Matches an element's own accessible label against the step's recorded
   * intent/description using the exact string-containment convention the
   * dedup guard in v2-task.js already uses, so "which element did that step
   * act on" means the same thing everywhere. Element ids are deliberately NOT
   * used: they are positional (`el_N`) and recomputed per extraction, so they
   * are not stable across cycles — the label is.
   *
   * @param {object} el
   * @param {object[]} steps
   * @returns {boolean}
   */
  /**
   * Is L2's ranking resting on evidence strong enough to ACT on?
   *
   * Returns a reason string when it is not (so the caller escalates to the
   * semantic tier), or null when L2 may commit. Both criteria come from
   * assessGrounding and are measured properties of the current candidate set,
   * never a site, phrase or synonym rule. A single viable candidate is never
   * treated as ambiguous — with no rival there is nothing to confuse it with.
   *
   * @param {{topScore:number, margin:number, rivals:number, unmatchedIntentTokens:string[]}} a
   * @returns {string|null}
   */
  _assessAmbiguity(a) {
    if (a.rivals <= 1) return null;

    if (a.margin < AMBIGUITY_MARGIN) {
      return `insufficient_margin:${a.margin.toFixed(3)}`;
    }

    // Words of the goal that appear nowhere on the page mean something is
    // missing from the evidence ONLY when the winner is a control the user
    // acts on. When the winner is a control that RECEIVES a value — a textbox,
    // textarea or combobox — those words are not missing evidence at all: they
    // are the value itself, and a value is not expected to be written on the
    // page. scoreElement already says exactly this ("a typed value meant for a
    // field rather than a label, e.g. a search query"), and treating that
    // expected absence as a gap put a strongly grounded, clearly actionable
    // field (measured 0.960) through the semantic tier and its timeout instead
    // of acting on it. Structural test only — a control's own role/tag, the
    // same distinction _buildPlanFromElement already draws. No site, phrase or
    // synonym is consulted.
    const top = a.ranked?.[0]?.element;
    const receivesValue = !!top && (
      ['textbox', 'combobox', 'searchbox', 'search'].includes(top.role) ||
      ['input', 'textarea'].includes(top.tag)
    );

    // Unmatched goal vocabulary also only matters when something else is
    // actually in contention. On its own it fires far too readily — a goal's
    // verb is very often absent from the page's own words ("add ..." on a page
    // that never says "add") — so a genuine rival is required too. Measured:
    // the runner-up held 0.34 of the winner's score where the lexical pick was
    // wrong, and 0.22 or less where it was right.
    // ...and only while the ranking has not already discriminated. A goal's
    // VERB is very often absent from a page's own words ("create ..." on a
    // menu that only says "New ..."), so on its own this fires constantly. If
    // the winner leads by a decisive margin there is no contest for the absent
    // word to create, and escalating costs a model round-trip — measured at
    // several seconds, and the single largest contributor to the delay a user
    // actually feels — to re-derive an answer the ranking already had.
    const contention = a.topScore > 0 ? (a.runnerUpScore / a.topScore) : 0;
    if (!receivesValue && a.unmatchedIntentTokens.length > 0 &&
        contention >= RIVAL_SHARE && a.margin < DECISIVE_MARGIN) {
      return `unmatched_intent_vocabulary:${a.unmatchedIntentTokens.join(',')}@contention=${contention.toFixed(2)}`;
    }
    return null;
  }

  /**
   * Structural, single-candidate fallback for when visual perception ran but
   * named no usable element (null, or an id that doesn't match anything in
   * the current page state). Not a second perception attempt and not a
   * guess: it looks for exactly ONE candidate that is already, on its own
   * metadata, an "unlabeled interactive control" — the same generic shape a
   * visually-only icon button has — and only resolves when there is no
   * ambiguity about which one that is.
   *
   * "Unlabeled interactive candidate" is determined ENTIRELY from existing
   * pageState metadata, never from what the element is or looks like:
   *   - an interactive role/tag (the same set PageStateService's own
   *     extraction selector already recognizes as a control worth
   *     extracting at all — see INTERACTIVE_ROLES/INTERACTIVE_TAGS above)
   *   - no text, no ariaLabel, no placeholder, no value — nothing lexical
   *     for L1/L2 to have matched it on, which is exactly why grounding and
   *     visual perception both had nothing to name it with
   *   - a valid element id and an existing, non-zero-area bbox — the two
   *     concrete pieces of evidence that this is a real, located control on
   *     the current page, not a phantom
   *
   * Returns the sole eligible element, or null when there are zero or two-or-
   * more equally eligible candidates — ambiguity is left to the existing
   * cloud fallback, never resolved by guessing between them.
   *
   * @param {object[]} elements - This cycle's full pageState.elements.
   * @returns {object|null}
   */
  _findSoleUnlabeledInteractiveCandidate(elements) {
    const eligible = (elements || []).filter((el) => {
      if (!el || el.visible === false || el.enabled === false) return false;
      if (!(INTERACTIVE_ROLES.has(el.role) || INTERACTIVE_TAGS.has(el.tag))) return false;
      if ((el.text || '').trim() || (el.ariaLabel || '').trim() ||
          (el.placeholder || '').trim() || (el.value || '').trim()) return false;
      if (typeof el.id !== 'string' || !el.id) return false;
      if (!el.bbox || !(el.bbox.width > 0) || !(el.bbox.height > 0)) return false;
      return true;
    });
    return eligible.length === 1 ? eligible[0] : null;
  }

  _isSettledTarget(el, steps) {
    const label = (el.text || el.placeholder || el.ariaLabel || '').trim().toLowerCase();
    if (!label) return false;
    return (steps || []).some((step) => {
      const stepIntent = (step.intent || '').trim().toLowerCase();
      const stepDesc   = (step.description || '').trim().toLowerCase();
      return stepDesc.includes(label) || stepIntent.includes(label);
    });
  }

  /**
   * Required-field gate: before treating a resolved CLICK target as the next
   * action, check whether its own form still has an empty required field.
   *
   * L1/L2 ground the goal's words against element labels — that is a lexical
   * match, not a check of whether the form is actually fillable yet. A
   * required field whose own label shares none of the goal's vocabulary
   * (measured: "Repository name" scores 0 against "create a new repo" — no
   * token in common at all, a limitation no threshold fixes) never becomes a
   * candidate on lexical grounds, so nothing here stopped a submit control
   * from winning even though the form it belongs to isn't ready to submit.
   *
   * The gate is structural, not lexical: the standard native `element.form`
   * association (`formId`) plus the standard `required` HTML attribute — the
   * same two signals a real browser already uses to refuse a premature submit.
   * No site knowledge, no synonym, no phrase table.
   *
   * When a gate fires, the redirect reuses _buildPlanFromElement exactly as
   * any other fill step: it extracts a value from the goal if one was stated,
   * or leaves it empty. The guide model does not type on the user's behalf
   * either way — an empty-value fill step highlights the field and waits for
   * the user, which is already how ScreenPilot asks for input. No new
   * clarification path is needed for this case.
   *
   * Only ever redirects TO the field, never invents a value FOR it, and only
   * applies when the resolved target is not itself the field being asked for
   * (an input target proceeds untouched — it IS the missing field).
   *
   * @param {string} goal
   * @param {object[]} elements - This cycle's full pageState.elements.
   * @param {object} candidate - L1/L2's own resolved target.
   * @returns {object|null} A ready plan response redirected to the missing
   *   field, or null when nothing gates the candidate.
   */
  _resolveRequiredFieldGate(goal, elements, candidate) {
    const candidateIsInput = ['textbox', 'combobox'].includes(candidate.role) || ['input', 'textarea'].includes(candidate.tag);
    if (candidateIsInput || !candidate.formId) return null;

    const missing = (elements || []).find((el) =>
      el.formId === candidate.formId &&
      el.required &&
      (['textbox', 'combobox'].includes(el.role) || ['input', 'textarea'].includes(el.tag)) &&
      el.visible && el.enabled !== false &&
      !(el.value || '').trim()
    );
    if (!missing) return null;

    return this._buildPlanFromElement(goal, missing, 0.9, 'ml_grounding');
  }

  /**
   * Structural continuation of an interaction a settled action STARTED but
   * did not finish.
   *
   * Withholding settled targets (see route()) is enough whenever the next
   * action is itself findable by grounding the goal — a newly revealed
   * control usually shares the goal's own vocabulary. It is NOT enough when
   * the continuation control's wording is unrelated to what remains of the
   * goal: measured on a filled search form, the next control scored 0.450,
   * below L2's threshold, so the cycle would fall through to a reasoning
   * model for something the page structure already determines.
   *
   * HTML defines exactly one such relationship generically: a control that
   * submits the form its filled field belongs to, via the standard native
   * `element.form` association (surfaced as `formId` by
   * page-state-service.js). That is what this resolves — no selector, no
   * phrase, no site knowledge, and nothing specific to search.
   *
   * Requires BOTH:
   *   (a) the field's live value is currently non-empty, AND
   *   (b) a settled action of this task targeted that field
   * — (a) alone is deliberately not enough: a field that merely had unrelated
   * pre-existing content (a genuine "change the email to..." goal on a
   * pre-filled field) must stay re-fillable, not be redirected to a submit
   * control it was never asked to reach.
   *
   * @param {object[]} elements - This cycle's full pageState.elements.
   * @param {object[]} settledSteps - Steps whose effect is the current state.
   * @param {object[]} [unsatisfiedRequirements] - See route()'s own doc
   *   comment. Checked immediately before this method would otherwise commit
   *   to the submit control — see _resolveUnsatisfiedRequirementCandidate.
   * @returns {object|null} A ready plan response, or null to fall through.
   */
  _resolveActionContinuation(elements, settledSteps, unsatisfiedRequirements) {
    if (!settledSteps?.length) return null;

    // The settled action's own target, located in the CURRENT state.
    const candidate = (elements || []).find((el) => {
      const isInput = ['textbox', 'combobox'].includes(el.role) || ['input', 'textarea'].includes(el.tag);
      return isInput && el.formId && (el.value || '').trim() && this._isSettledTarget(el, settledSteps);
    });
    if (!candidate) return null;

    const submitCandidates = elements.filter((el) =>
      el.formId === candidate.formId &&
      el.id !== candidate.id &&
      el.visible && el.enabled !== false &&
      (el.type === 'submit' || el.tag === 'button' || el.role === 'button')
    );
    if (!submitCandidates.length) return null;

    // Prefer an explicit type="submit" control; with no explicit submit type,
    // only act when there is exactly ONE unambiguous button in the same form
    // — multiple same-form buttons with no explicit submit type isn't a safe
    // enough generic signal to pick between them.
    const target = submitCandidates.find((el) => el.type === 'submit') ||
      (submitCandidates.length === 1 ? submitCandidates[0] : null);
    if (!target) return null;

    // Goal-requirement gate — checked BEFORE this method commits to the
    // submit control. Mirrors _resolveRequiredFieldGate's own established
    // pattern (defer a locally-plausible match to a different, more-relevant
    // UNADDRESSED candidate) generalized from the HTML `required` attribute
    // to the goal's own declared, not-yet-satisfied successSignals. See that
    // method's own call sites (L1/L2 above) for the precedent this follows.
    const requirementRedirect = this._resolveUnsatisfiedRequirementCandidate(
      elements, settledSteps, target.id, unsatisfiedRequirements
    );
    if (requirementRedirect) return requirementRedirect;

    const candidateLabel = (candidate.text || candidate.placeholder || candidate.ariaLabel || '').trim();
    const plan = this._buildPlanFromElement(candidateLabel, target, 0.9, 'ml_grounding');
    plan.plan.steps[0].completionCondition = 'final';
    return plan;
  }

  /**
   * Before structural continuation trusts a settled field's own submit
   * control, check whether the GOAL ITSELF — via its own declared,
   * not-yet-historically-satisfied successSignals (see v2-task.js's
   * requirementProgress model) — still needs something ELSE on this same
   * page. Purely generic: ranks each unsatisfied signal's own `text` against
   * the currently unaddressed candidates using the exact same lexical
   * ranking L1/L2 already use (UIGroundingService.rankElements) — no form,
   * field-name, action-type, or site-specific vocabulary of any kind, and no
   * awareness of what "submit" or "final" mean. A `url_matches` signal
   * describes the URL, not any one control, so it has nothing to rank
   * against here and is skipped, not treated as satisfied or unsatisfied.
   *
   * Returns null (preserving the existing submit continuation byte-for-byte)
   * whenever unsatisfiedRequirements is empty/absent, or no unsatisfied
   * signal's text ranks above rankElements' own relevance floor against any
   * currently unaddressed candidate — including the common case where the
   * goal has exactly one requirement and submitting IS what satisfies it.
   *
   * @param {object[]} elements - This cycle's full pageState.elements.
   * @param {object[]} settledSteps - Steps whose effect is the current state.
   * @param {string} excludeElementId - The submit control continuation was
   *   about to choose; never itself offered as an "other" candidate.
   * @param {object[]} [unsatisfiedRequirements] - successSignal-shaped
   *   {type, text} | {type, urlPattern} entries, in the goal's own declared
   *   order.
   * @returns {object|null} A ready plan response targeting the first
   *   matching unaddressed candidate, or null to fall through unchanged.
   */
  _resolveUnsatisfiedRequirementCandidate(elements, settledSteps, excludeElementId, unsatisfiedRequirements) {
    if (!Array.isArray(unsatisfiedRequirements) || !unsatisfiedRequirements.length) return null;

    const unaddressed = (elements || []).filter((el) =>
      el.id !== excludeElementId &&
      el.visible && el.enabled !== false &&
      !this._isSettledTarget(el, settledSteps)
    );
    if (!unaddressed.length) return null;

    for (const signal of unsatisfiedRequirements) {
      if (!signal?.text) continue;
      const ranked = UIGroundingService.rankElements(signal.text, unaddressed);
      if (ranked.length) {
        console.log(`[SP:DecisionRouter] Structural continuation deferred — unsatisfied requirement "${signal.text}" matches unaddressed elementId=${ranked[0].element.id} (score=${ranked[0].score.toFixed(3)})`);
        return this._buildPlanFromElement(signal.text, ranked[0].element, ranked[0].score, 'ml_grounding');
      }
    }
    return null;
  }

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
    // A native <input> tag is not on its own evidence of a TEXT-ENTRY field —
    // checkbox/radio/switch are also tag 'input' but hold a distinct,
    // already-computed semantic role (page-state-service.js's getRole()).
    // Checking the tag before the role classified any checkbox/radio as
    // fillable, tagging its step phase:'fill_form' — which then fell into a
    // dead zone downstream: executor-engine.js's fill-detection explicitly
    // excludes checkbox/radio/switch by design (they complete via a click,
    // never via typed input), and disables its own click-detection path for
    // any fill_form-phase step, so the interaction could never be recognized
    // as complete regardless of how it was actually acted on. Consulting the
    // role first — the same role this file's own candidate search above
    // already uses — routes a checkbox/radio to the 'navigate' branch below,
    // whose completion the executor's existing click handler already
    // recognizes generically. No new taxonomy: 'switch' is included for the
    // same reason role-classified toggles exist at all elsewhere in this
    // file (see _resolveRequiredFieldGate's sibling checks).
    const isInput = ['textbox', 'combobox', 'search'].includes(element.role) ||
      (['input', 'textarea'].includes(element.tag) && !['checkbox', 'radio', 'switch'].includes(element.role));
    // The element's OWN accessible name ONLY — never falls back to the goal.
    // This is deliberately kept separate from `displayLabel` below: it is the
    // exact field the executor's DOMMatcher searches the live DOM by
    // (targetElement.text), so it must describe what the element on the page
    // actually IS, never what the user asked for. Previously this fell back
    // to `goal` when the element had no text/placeholder/ariaLabel at all (a
    // purely visual control, e.g. an icon-only button) — a fabricated label
    // that became the literal (unmatchable) search key the executor tried
    // and failed to find any element's text equal to. An empty string here
    // is instead an honest, generic signal — element-agnostic, not specific
    // to any one kind of control — that text-based matching cannot work for
    // this target; see executor-engine.js's _resolveElement, which falls
    // back to the element's own already-known `bbox` (below) in that case.
    const elementOwnLabel = element.text || element.placeholder || element.ariaLabel || '';
    // Human-readable only — description/intent/UI. Falls back to the goal so
    // a step is never displayed with a blank name; this fallback is NOT
    // copied into targetElement.text (see above), which is what keeps a
    // human-facing label from ever being used as a DOM search key.
    const displayLabel = elementOwnLabel || goal;
    // L1/L2/vision are lexical/structural matchers, not semantic reasoners:
    // they have no reliable, generic way to extract a user-provided value
    // distinct from the goal (that is Qwen's job — see local-qwen-adapter.js's
    // _formatPlanResponse, which builds its step the same way but with a real
    // `value` when one was semantically extracted). `value` stays empty here
    // by design, not as a special case — it keeps this step shape identical
    // across every tier.
    const value   = isInput ? extractRequestedValue(goal, displayLabel) : '';
    const action  = isInput ? 'fill_form' : 'navigate';

    const step = {
      id: 1,
      description: value
        ? `Type '${value}' into '${displayLabel}'`
        : `${isInput ? 'Fill' : 'Click'} '${displayLabel}'`,
      intent: `${isInput ? 'fill' : 'click'}_${displayLabel}`,
      phase: action,
      completionCondition: 'dom_change',
      targetElement: {
        text: elementOwnLabel,
        type: isInput ? 'input' : 'button',
        intent: displayLabel,
        value,
        elementId: element.id,
        region: element.region ?? null,
        // Already produced by PageStateService (getBoundingClientRect) and
        // already used for vision candidate markers — forwarded here, not
        // recomputed, so the executor has the same known on-page position to
        // fall back to when targetElement.text is empty (see above).
        bbox: element.bbox ?? null
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
      plannerSummary: `[Layer: ${layer}] Resolved target element '${displayLabel}' with confidence ${confidence}`,
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
