# ScreenPilot evaluation harness

Measures the five project evaluation metrics against the **unmodified** extension.
Nothing in `extension/` is changed or instrumented for the benchmark. The harness only reads what ScreenPilot already logs, renders, or returns.

| Metric | Script | Result file |
|---|---|---|
| 1. Visual-context accuracy | `run-visual.mjs` | `results/visual-accuracy.json` |
| 2. PII precision / recall | `run-privacy.mjs` | `results/privacy.json` |
| 3. Redaction precision | `run-privacy.mjs` | `results/privacy.json` (+ `privacy-redacted-output-v*.jpg`) |
| 4. Client resource utilization | `run-e2e.mjs` | `results/resources.json` |
| 5. End-to-end latency | `run-e2e.mjs` | `results/e2e-latency.json` |

`report.mjs` renders all of them into `docs/METRICS.md`.

## Run

Prerequisites:
- Windows, since the resource sampler uses WMI/CIM.
- Ollama running with `qwen2.5-coder:7b` and `moondream` pulled.
- The extension built with `npm run build:ext`.
- Playwright's Chromium, which is already a dev dependency. If it's missing, run `npx playwright install chromium`.

```
npm run test:eval                 # unit tests for the harness's own arithmetic/parsing
npm run eval:privacy              # metrics 2 + 3  (~1 min, no Ollama needed)
npm run eval:visual -- --reps 3   # metric 1       (~15-20 min)
npm run eval:e2e -- --reps 5      # metrics 4 + 5  (~15-20 min)
npm run eval:report               # -> docs/METRICS.md
```

Options: `--case <id>` (visual), `--task <id>` (e2e), `--timeout <ms>`.

A Chromium window opens during runs. This is deliberate: `chrome.tabs.captureVisibleTab` returns "image readback failed" in headless mode, and the vision, cloud and redaction paths all depend on a real capture. Don't use the machine heavily while `eval:e2e` runs, because the resource metric measures the whole machine.

## What is measured vs. manually entered

- **Manually entered ground truth** lives only in `ground-truth/`:
  - `visual-cases.json`: goal and expected target element ID per case (`null` means the correct behaviour is to highlight nothing).
  - `privacy-fields.json`: sensitive or not, per element.
  - `e2e-tasks.json`: tasks, plus what the simulated user types.
- **Everything else is measured.** The sources are ScreenPilot's own console output (ISO-timestamped `STATE` transitions, `[SP:V2:PERF]` timings, `DecisionRouter` decision lines), its rendered highlight ring, the JPEG its capture pipeline returns, and Windows process counters.

## How ScreenPilot is driven

1. The real unpacked extension is loaded into Playwright's Chromium.
2. Goals are submitted through `window.__SP_V2_RUN`, which is the same `_startNewTask` the overlay's Start button calls. It runs in the extension's content-script world and is reached over CDP.
3. ScreenPilot plans and highlights on its own.
4. The harness plays the user:
   - It reads which element the highlight ring surrounds.
   - It clicks that element with a real mouse event, or types into it if it's a text field listed in `userInputs`.
   - It then waits for ScreenPilot to verify and complete.
5. The execution mode is `local-qwen`. That's the local-first configuration, so the cloud is used only as ScreenPilot's own fallback.

## Metric definitions

### 1. Visual-context accuracy

Visual-context accuracy = correct first-target identifications / total runs.
- A positive case is correct when the first element ScreenPilot highlights is the expected element **or lies inside it** (e.g. the `<svg>` icon inside the expected button — clicking it activates that button). The highlighted element is the page element under the ring's centre whose box best matches the ring (IoU ≥ 0.5, ring minus its 5 px pad); its nearest ancestor-or-self with an `id` is the reported target. A highlighted wrapper/container never maps down to a control inside it.
- A negative case is correct when nothing is highlighted.

Also reported:
- **Local-only accuracy:** a positive case counts only if a local mechanism chose it, without the cloud.
- **Per-category and per-mechanism accuracy.** Mechanisms are L1, L2, Qwen, Moondream, the structural single-candidate fallback, and cloud.
- **Moondream and Qwen inference latency.**

### 2. PII precision/recall

For every ground-truth element, "predicted" means the production detector flagged it. Precision = TP/(TP+FP), recall = TP/(TP+FN), plus F1. Both detectors in the product are measured on the same page:
- **V2** `PageStateService` + `PrivacySanitizer`, used by the agent (Qwen, Moondream, cloud).
- **V1** `getSensitiveScreenshotRegions` in `content.js`, used by Explain/Ask. It is sliced verbatim from `content.js`, the same way `extension/tests/content-privacy-context.test.mjs` does it.

### 3. Redaction precision

Each detector's regions go through the extension's own `CAPTURE_SCREENSHOT` path: `captureVisibleTab` → resize → black fill → JPEG.
- **Pixel redaction precision** = |painted ∩ sensitive| / |painted|.
  - "Painted" means pixels that are black in the redacted capture but not in a reference capture taken through the same pipeline with no regions. Black means max channel ≤ 40.
  - "Sensitive" means pixels inside ground-truth sensitive element boxes.
- **Sensitive coverage** = |black ∩ sensitive| / |sensitive|, over *all* ground-truth sensitive elements, so detection misses count against it.
- **IoU** between each ground-truth box and its production redaction rectangle (`ScreenshotService.computeRedactionRects`): reported per region, as a mean, and as the share of regions with IoU ≥ 0.5 and ≥ 0.9.
- **False-redaction area:** pixels, and percentage of the non-sensitive area.

Only the redacted output JPEG is written to disk. The no-region reference stays in memory.

### 4. Client resource utilization

A WMI/CIM sampler runs for the whole E2E suite.
- **What it samples:** system CPU %, system RAM in use, and per-process CPU time and working set for:
  - each model's `llama-server.exe`, attributed to Qwen or Moondream through Ollama's own manifest files;
  - `ollama.exe`;
  - Playwright's Chromium (the user's own Chrome is excluded).
- **How CPU % is computed:** per process it is ΔCPU time / Δwall / logical cores, which is the whole-machine percentage Task Manager shows.
- **Windows reported:** idle baseline, all task activity, Qwen inference, Moondream inference, and each task. Inference windows run from the router's own start line to the adapter's own latency line.
- **GPU:** no GPU figure is reported. Ollama reports `size_vram = 0`, meaning CPU-only inference, and that report is recorded.

### 5. E2E latency

Latency is measured from `GOAL_SUBMITTED` to `PLAN_COMPLETE`, using ScreenPilot's own STATE timestamps, over runs that reach COMPLETE. Mean, median, min and max come from `--reps` measured runs per task after one warm-up; the warm-up (first-run) total is reported separately. The total is split into:
- **planning:** time in PLANNING;
- **highlight:** time in EXECUTING;
- **simulated user:** time in AWAITING_USER;
- **verification:** time in VALIDATING;
- **system:** total − simulated user.

Model inference times are ScreenPilot's own `qwenLatencyMs` and `visionLatencyMs`.

## Known limitations of the measurements

- **The "user" is simulated.** Playwright acts within about 50–100 ms of the highlight appearing. Its time is reported separately so it never hides system latency. For fills it includes ScreenPilot's own 600 ms typing-idle wait.
- **Fixtures are synthetic and small** (13 visual cases, 29 privacy elements). They characterise behaviour; they are not a statistically broad sample of the web.
- **Sampling resolution is about 1 s** (CIM queries are slow). Sub-second tasks show up only as the intervals that contain them. Model-inference windows (10–30 s) are well resolved.
- **Cloud results depend on the cloud backend being reachable during the run.** Every run records which mechanism decided, and local-only accuracy is reported separately.
- **Viewport and device-scale emulation are deliberately disabled.** With Playwright's `deviceScaleFactor: 1` on a 150%-scaled display, the page reports `devicePixelRatio = 1` while `captureVisibleTab` captures at 1.5×, so production redaction boxes land at ⅔ of their true position. That never happens in a normal Chrome window, including under page zoom. It is recorded as a product assumption: redaction trusts `devicePixelRatio`.
