# TASK_METRICS.md — ScreenPilot Telemetry Reference

Generated: 2026-06-22
Phase: 1 — Validate Multi-Step Planning

---

## Storage

All analytics are stored in `chrome.storage.local` under the key `screenpilot_analytics`.

```jsonc
{
  "tasks": [/* up to 100 TaskRecord objects, FIFO eviction */],
  "totalCacheHits": 42,      // global counter; never evicted
  "updatedAt": 1750000000000 // epoch ms of last write
}
```

---

## TaskRecord Schema

| Field | Type | Description |
|---|---|---|
| `taskId` | string | Short ID — `Date.now().toString(36) + random(3 chars)` |
| `goal` | string | First 200 chars of user goal |
| `startedAt` | number | Epoch ms when task was created |
| `completedAt` | number \| null | Epoch ms when task was finalized |
| `durationMs` | number \| null | `completedAt - startedAt` |
| `geminiCalls` | number | Total calls to the Gemini backend (including retries and fallbacks) |
| `geminiErrors` | number | Calls that returned `success: false` |
| `totalGeminiLatencyMs` | number | Sum of all Gemini round-trip times |
| `planGenerated` | boolean | Whether Gemini returned a `plan[]` for this task |
| `planStepsTotal` | number | Number of steps in the generated plan |
| `planStepsAttempted` | number | Plan steps where DOM matching was attempted |
| `planStepsSucceeded` | number | Steps executed via DOM-only (no Gemini), confirmed by `ADVANCE_PLAN_STEP` |
| `planStepsFailed` | number | Steps where DOM match score < 70 → fell back to Gemini |
| `fallbackCalls` | number | Times a plan step failure triggered a new Gemini call |
| `completionStatus` | string | `completed` / `failed` / `aborted` / `active` |
| `completionReason` | string | Machine-readable reason code |

---

## Global Counters

| Field | Type | Description |
|---|---|---|
| `totalCacheHits` | number | Times `PageStateCache.get()` returned a cached response (no Gemini call) |

Cache misses are implicit: every `geminiCalls` increment represents a cache miss for that request.

---

## KPI Definitions

### Plan Success Rate
```
planSuccessRate = planStepsSucceeded / planStepsAttempted
```
Measures how often DOM-only plan execution works without falling back to Gemini.

- **Healthy**: ≥ 60%
- **Warning**: 40–60%
- **Action needed**: < 40% — plan quality or DOM matching needs improvement

### Gemini Calls Per Task
```
geminiCallsPerTask = totalGeminiCalls / finishedTasks
```
Core cost metric. Reflects how many API calls each task requires on average.

- **Healthy**: ≤ 2.0 (plan working well — first call generates plan, second is a fallback)
- **Warning**: 2–4
- **Action needed**: > 4 — planning is not reducing Gemini usage

Baseline without planning: ~1 call per step, so a 5-step task = ~5 calls.
With planning: 1 call generates the plan + fallbacks only = target 1–2 calls.

### Task Completion Rate
```
taskCompletionRate = completedTasks / finishedTasks
```
Fraction of tasks that reached `Task complete` vs. failing or being aborted.

- **Healthy**: ≥ 70%
- **Warning**: 40–70%

### Average Task Latency
```
avgTaskLatencyMs = sum(durationMs) / completedTasks
```
End-to-end wall-clock time from task start to completion.
Most of this is Gemini latency × number of calls.

### Cache Hit Rate
```
cacheHitRate = totalCacheHits / (totalCacheHits + totalGeminiCalls)
```
Fraction of ANALYZE_GOAL requests served from PageStateCache (no API call).

- **Healthy**: ≥ 30% (user often retries Go on same page)
- **Warning**: < 10%

### Fallback Rate
```
fallbackRate = tasksWithFallback / tasksWithPlan
```
Fraction of planned tasks that needed at least one Gemini fallback.

- **Healthy**: ≤ 40% (most plans execute cleanly)
- **Action needed**: > 70% — plan steps are not matching DOM reliably

---

## Collection Points

| Event | File | Location | Method called |
|---|---|---|---|
| Task started | `background.js` | `analyzeGoal()` | `TelemetryService.startTask()` |
| Gemini call | `background.js` | `runVisionCycle()` after await | `TelemetryService.recordGeminiCall()` |
| Plan generated | `background.js` | `runVisionCycle()` after analysis | `TelemetryService.recordPlanGenerated()` |
| Plan step succeeded | `background.js` | `advancePlanStep()` | `TelemetryService.recordPlanStep(id, true)` |
| Plan step failed | `content.js` | `tryPlanStep()` on low score | `TELEMETRY_EVENT PLAN_STEP_FAILED` → background |
| Plan fallback to Gemini | `background.js` | `reanalyzeGoal()` on plan- reason | `TelemetryService.recordFallback()` |
| Cache hit | `content.js` | `requestAnalysis()` cache check | `TELEMETRY_EVENT CACHE_HIT` → background |
| Task completed | `background.js` | `runVisionCycle()` on complete | `TelemetryService.completeTask(id, 'completed')` |
| Task failed | `background.js` | `runVisionCycle()` on error | `TelemetryService.completeTask(id, 'failed')` |
| Task aborted | `background.js` | `abortTask()` | `TelemetryService.completeTask(id, 'aborted')` |

---

## Storage Size Estimate

Max 100 tasks × ~500 bytes per record = ~50 KB  
`chrome.storage.local` quota: 10 MB — well within limits.

---

## Developer Dashboard

Open the ScreenPilot popup → click **Analytics** tab.

**KPI cards** (top 4):
- Plan Success Rate
- Cache Hit Rate
- Gemini / Task
- Task Completion

**Recent Tasks table** (last 20):
- Coloured dot = completion status (green/red/grey)
- Goal text (truncated)
- `{N}G` = Gemini calls, `{S}/{A}p` = plan steps succeeded/attempted

**Clear all** wipes `chrome.storage.local['screenpilot_analytics']`.

---

## Known Limitations (Phase 1)

1. **Cache misses not tracked per-task** — only global (global counter is accurate).
2. **Service worker restarts** drop in-flight task buffers. Tasks that crash mid-cycle are not recorded.
3. **Plan step attempted count** is derived from succeeded + failed; a step that partially executed (highlight failed after DOM match) is counted as succeeded by ADVANCE_PLAN_STEP (because the DOM match itself worked).
4. **No timestamp per plan step** — can't calculate step-level latency breakdown yet.

These will be addressed in Phase 2 when real validation data is collected.

---

## Validation Targets (Phase 1 Goal)

Run 5–10 tasks each on: Gmail, Google Docs, GitHub, Jira, Notion, LinkedIn, Linear.

Expected outcomes to validate:
- Gemini calls per task < 3 (planning working)
- Plan success rate > 50% (DOM matching reliable on major apps)
- Cache hit rate > 20% (users retry on same page)

If Plan Success Rate < 40%, investigate:
- DOMMatcher scoring thresholds (PLAN_STEP_MIN_SCORE = 70)
- Plan step element text precision from Gemini
- SPA navigation timing (element not yet in DOM when matched)
