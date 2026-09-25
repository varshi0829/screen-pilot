# Regression: "Search Wikipedia for artificial intelligence" selects "English" instead of the search box

## Symptom (real browser, reported twice)

Goal: `Search Wikipedia for artificial intelligence` on `https://www.wikipedia.org/`.

- First report: ScreenPilot clicked "English", then typed "Search Wikipedia" into the search box.
- Second report (after the target/value-conflation fix in the Qwen adapter and the L2
  ranked-candidate-slice fix in the router): still selected "English 7,237,000+ articles"
  instead of the search input.

Both reports name the same visible failure — the wrong element is chosen — but the second
failure persisted after the two fixes above, so it could not be the same root cause. The
following method was used to find the actual cause without touching the codebase, per the
project rule of diagnosing before modifying code.

## Method

A temporary, repo-external script (never committed) imported the real, unmodified
`UIGroundingService`, `DecisionRouter` (`QWEN_CANDIDATE_LIMIT`), and `LocalQwenAdapter`
modules directly via `file://` URLs, and reconstructed a realistic Wikipedia-portal page
state: the 30 real language links (name, article count, unit, e.g. `English 7,237,000+
articles`) plus a search input and search button, in two scenarios:

1. **Search box labeled** — `placeholder="Search Wikipedia"` on the input, `aria-label="Search"`
   on the button (representative of a well-labeled site).
2. **Search box unlabeled** — no `placeholder`/`aria-label` on either element (representative
   of a site whose search box's name comes only from a `<label>`/`aria-labelledby` association
   that PageState did not previously resolve, or from no accessible name at all).

For each scenario it ran the real `rankElements()`/`scoreElement()` L2 functions, computed the
exact candidate slice `decision-router.js` would send to Qwen (`QWEN_CANDIDATE_LIMIT`), built
the real Qwen prompt via `LocalQwenAdapter._buildQwenPrompt()`, and made a real call to the
local Ollama `qwen2.5-coder:7b` model via `LocalQwenAdapter.plan()`.

## Results

### Scenario 1 — search box HAS `placeholder`/`aria-label`

- L2 `ranked` (score > 0.05): 2 candidates — `el_search_input` score **0.960**,
  `el_search_button` score **0.430**.
- Direct `scoreElement()` for the "English 7,237,000+ articles" link: **0**.
- Qwen candidate list: both real elements (search input + search button); "English" never
  reaches Qwen at all.
- Real Qwen call (11909ms): `{"action":"type","elementId":"el_search_input"}`,
  `targetElement.value:"artificial intelligence"`, description `Type 'artificial
  intelligence' into 'Search Wikipedia'` — **fully correct**.

### Scenario 2 — search box has NO `placeholder`/`aria-label`

- L2 `ranked` count: **0**. Both the search input and the "English" link score exactly 0 —
  the search input scores 0 because it has no matchable text at all (empty `text`,
  `placeholder`, `ariaLabel`), not because "English" outscored it.
- Candidate-selection fallback (`ranked.length ? ... : elements`) sends all 25 (capped) raw,
  DOM-order language-link elements to Qwen — in real production this fallback branch is dead
  code, since `decision-router.js` only invokes Qwen when `ranked.length > 0`
  (`hasViableTextCandidates`); with zero ranked candidates the router would pick Moondream
  instead in this exact synthetic scenario.
- Real Qwen call timed out at 15017ms (`errorCode: OLLAMA_UNAVAILABLE`,
  `error: "qwen_timeout_15000ms"`) — unsurprising, since no plausible candidate existed in the
  list it was given at all.

## Conclusion drawn from this evidence

When the search box has no accessible name that `PageStateService.extractPageState()` can
extract (`text`, `placeholder`, and `ariaLabel` all empty), it scores exactly 0 in L2 and is
functionally invisible to the whole L1→L2→L3 pipeline — it cannot be picked over "English" by
any scoring logic, and it cannot be fixed by ranking/candidate-selection changes in the router
or the Qwen adapter, both of which only ever operate on candidates PageState already extracted.

This does **not** prove which local provider (`local_qwen` vs `local_vision`) produced the
real second-browser-failure decision — the synthetic scenarios above show what each stage does
in isolation, not what actually ran in that specific browser session, and no instrumentation
existed at the time to capture that. See the "generic accessible-name extraction" fix in
[`page-state-service.js`](../../extension/services/page-state-service.js) (`resolveAccessibleName`)
for the fix that addresses the representation gap this evidence identifies, and the
`[SP:DecisionRouter]`/`[SP:V2:PERF]` debug logging (documented in
[`DECISION_ROUTER.md`](../DECISION_ROUTER.md)) for the instrumentation that can confirm which
provider runs on the next real-browser attempt.

The fix deliberately does **not** touch L2 scoring, add another model/layer, or add any
Wikipedia-specific or search-specific logic — it only teaches `PageStateService` to read
accessible names from the standard DOM/ARIA relationships (`aria-labelledby`, `label[for]`,
an ancestor `<label>`) that it was previously not reading at all, so that a search box (or any
other control) labeled only through one of those relationships is no longer invisible to the
scoring pipeline in the first place.
