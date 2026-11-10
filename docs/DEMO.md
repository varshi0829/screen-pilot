# Demo script (2–3 minutes)

**Status: this script has NOT been executed end-to-end in the preparation pass for this document.** The automated tests pass, and scripted headless-Chromium runs of a similar Wikipedia search task (highlight, user input, replan, completion) succeeded once; see the "Checked in a real browser" section of [SETUP.md](SETUP.md). A recorded, manually driven run has not been done, so run it once yourself before recording and correct anything that differs. Do not present expected behaviour here as measured.

## Setup (before recording)

1. Backend and extension installed per [SETUP.md](SETUP.md). Confirm `GET /api/health` is `ok` if you use cloud mode.
2. Decide the mode up front:
   - **Cloud (default):** needs a reachable backend with a provider key. For a local backend, set Settings → Backend URL to `http://localhost:3000`.
   - **Local:** Ollama running with `qwen2.5-coder:7b`; tick *Local AI* in the popup. Expect multi-second pauses on CPU — `docs/METRICS.md` measured a ~12 s median Qwen call on one machine. Say so on camera rather than editing it out.
3. Open DevTools → Console, filter on `SP:` so the layer chosen for each step is visible (`layer=L3 reason=…`, `[SP:V2:PERF] …`).

## Scenario A — deterministic path (no model call)

Goal: **"Search for artificial intelligence"** on `https://en.wikipedia.org`.

| # | You do | Expected |
|---|---|---|
| 1 | Open the popup, enter the goal, start | A highlight with an instruction appears on the search box |
| 2 | Point at the console | The step was resolved by L1/L2 (no `layer=L3` line for it) |
| 3 | Type the query yourself | ScreenPilot waits; it does not type. Completion is not declared on the first keystroke |
| 4 | Press Enter | Page navigates; ScreenPilot verifies the new state and finishes |

What it demonstrates: deterministic grounding first, guide-only, verification after the user acts.

## Scenario B — duplicate controls (executor identity)

Use any page with repeated same-labelled controls (e.g. a list of rows each with a "Settings" or "Delete" button) and a goal that names one row. Expected: ScreenPilot highlights the control in the named row, or reports it cannot tell and asks (`identity UNRESOLVED … failing closed`). It must not highlight an arbitrary same-labelled button. Covered by `executor-identity-*.test.mjs` and `contextual-grounding.test.mjs`; not re-run live here.

## Scenario C — sensitive field

Goal that leads to a login form. Expected: when the password field is highlighted the instruction says the user must enter it themselves; ScreenPilot does not type. In cloud mode, console `[SP:PII]` events show types and counts only, never values.

## Suggested recording outline

| Time | Content |
|---|---|
| 0:00–0:20 | One sentence: guides, doesn't act. Show the pipeline diagram from the README |
| 0:20–1:15 | Scenario A, console visible |
| 1:15–2:00 | Scenario B or C |
| 2:00–2:30 | Show `npm run test:ext` summary and the Known limitations list |

## Known failure cases and how to read them

| Symptom | Likely meaning |
|---|---|
| Nothing highlights; console shows `identity UNRESOLVED (…)` | Duplicate-element protection refused to guess. Working as designed, but a usability limit |
| Long pause, then cloud step | Local Qwen unavailable/timed out and the router escalated |
| "Several controls match … Which one did you mean?" | L2 saw a real tie and the reasoning tier couldn't resolve it |
| Local mode never uses Moondream | It runs only when there are zero text candidates, and `moondream` must be pulled |
| Cloud mode errors on a custom backend | Check Settings → Backend URL (https, or http for localhost only) and that `/api/health` responds |
| Site blocks automation / login walls | Not supported; ScreenPilot can't help past an auth wall it can't see |
