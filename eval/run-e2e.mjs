// Evaluation metrics 4 & 5 — client resource utilization and end-to-end latency.
//
// E2E latency (metric 5): for each task, goal submitted → ScreenPilot plans →
// highlights → simulated user acts → ScreenPilot verifies → PLAN_COMPLETE.
// Timestamps are ScreenPilot's own ISO-stamped STATE transition logs
// (GOAL_SUBMITTED … PLAN_COMPLETE), so the harness's own overhead is not
// counted. Only runs that reach COMPLETE count as successful; success rate is
// reported alongside. Per run the total is split into planning / highlight /
// user-action / verification (see metrics.phaseBreakdown). userAction is the
// SIMULATED user's time (Playwright click/typing + ScreenPilot's own 600 ms
// typing-idle wait for fills) and is reported separately; "system" latency =
// total − userAction.
//
// Protocol per task: 1 warm-up run (recorded separately as the cold/first-run
// figure) then --reps measured runs (default 5).
//
// Resource utilization (metric 4): a Windows CIM sampler runs for the whole
// suite (see lib/resource-monitor.mjs). Reported over: an idle baseline, all
// task activity, Qwen inference windows, Moondream inference windows (from
// ScreenPilot's own router/adapter log lines), per group: each model's
// llama-server process, the Ollama server, the benchmark Chromium.
//
// Run:  node eval/run-e2e.mjs [--reps 5] [--task <id>] [--timeout 180000]
// Needs: Ollama running with qwen2.5-coder:7b and moondream; npm run build:ext.

import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, launchExtensionBrowser, openPage, runGoal, actOn, ollamaPs,
  writeResult, machineInfo, inferenceWindows, REPO_ROOT,
} from './lib/harness.mjs';
import { fixturePage, loadJson, parseArgs } from './lib/fixtures.mjs';
import { parseStateEvents, parseDecisions, parsePerf, phaseBreakdown, summarize } from './lib/metrics.mjs';
import { startResourceMonitor, ollamaBlobToModel, toIntervals, aggregate } from './lib/resource-monitor.mjs';

const args = parseArgs();
const reps = Number(args.reps ?? 5);
const timeoutMs = Number(args.timeout ?? 180_000);
const IDLE_BASELINE_MS = 10_000;
const { tasks: allTasks } = loadJson('eval/ground-truth/e2e-tasks.json');
const tasks = args.task ? allTasks.filter((t) => t.id === args.task) : allTasks;
if (!tasks.length) throw new Error(`No task matches --task ${args.task}`);

// Neutral paths (see fixtures.casePath for why ids never appear in URLs/titles).
const pages = {};
tasks.forEach((t, i) => {
  pages[`/task/${i + 1}`] = t.page.htmlFile
    ? fs.readFileSync(path.join(REPO_ROOT, t.page.htmlFile), 'utf8')
    : fixturePage(t.page.html, 'Benchmark page');
  for (const [p, html] of Object.entries(t.extraPages ?? {})) pages[p] = fixturePage(html, 'Benchmark page');
});

const server = await startServer(pages);
const browser = await launchExtensionBrowser({ executionMode: 'local-qwen' });
const monitor = startResourceMonitor();
const runs = [];
let baselineWindow;
const psAtStart = await ollamaPs();

try {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, IDLE_BASELINE_MS));
  baselineWindow = { start: t0, end: Date.now() };

  for (const [i, task] of tasks.entries()) {
    for (let rep = 0; rep <= reps; rep++) {
      const loadedBefore = (await ollamaPs())?.map((m) => m.name) ?? null;
      const handle = await openPage(browser, `${server.origin}/task/${i + 1}`);
      const actions = [];
      const result = await runGoal(handle, task.goal, {
        timeoutMs,
        simulateUser: async (h) => {
          const id = h.targetId;
          if (!id) { actions.push({ action: 'none', reason: 'highlight not attributable to a page element' }); return false; }
          const value = task.userInputs?.[id];
          if ((h.targetTag === 'input' || h.targetTag === 'textarea') && value != null) {
            await actOn(handle.page, h, { type: 'fill', value });
            actions.push({ action: 'fill', target: id });
          } else {
            await actOn(handle.page, h, { type: 'click' });
            actions.push({ action: 'click', target: id });
          }
          return true;
        },
      });
      await handle.close();

      const events = parseStateEvents(result.lines);
      const phases = phaseBreakdown(events);
      const perf = parsePerf(result.lines);
      const run = {
        taskId: task.id,
        rep,
        warmup: rep === 0,
        completed: phases?.outcome === 'COMPLETE',
        outcome: phases?.outcome ?? result.stopReason,
        stopReason: result.stopReason,
        ...phases,
        mechanisms: parseDecisions(result.lines),
        actions,
        qwenLatencyMs: perf.qwenLatencyMs,
        visionLatencyMs: perf.visionLatencyMs,
        totalPlanningMsPerCycle: perf.totalPlanningMs,
        screenshotMs: perf.screenshotMs,
        postActionVerifyMs: perf.postActionVerifyMs,
        modelsLoadedBeforeRun: loadedBefore,
        taskWindow: { start: result.startedAt, end: result.startedAt + result.wallMs },
        inferenceWindows: inferenceWindows(result.entries),
      };
      runs.push(run);
      console.log(
        `${run.warmup ? 'WARMUP ' : 'MEASURE'} ${task.id} #${rep}: ${run.outcome} total=${run.totalMs ?? '-'}ms ` +
        `system=${run.systemMs ?? '-'}ms planning=${run.planningMs ?? '-'}ms user=${run.userActionMs ?? '-'}ms ` +
        `qwen=${perf.qwenLatencyMs.join('/') || '-'} vision=${perf.visionLatencyMs.join('/') || '-'} via ${run.mechanisms.join('>') || '-'}`,
      );
    }
  }
} finally {
  var samples = await monitor.stop();
  await browser.close();
  await server.close();
}

// ── Latency aggregation (measured runs only; warm-up reported separately) ──
const latency = {};
for (const task of tasks) {
  const measured = runs.filter((r) => r.taskId === task.id && !r.warmup);
  const ok = measured.filter((r) => r.completed);
  const warm = runs.find((r) => r.taskId === task.id && r.warmup);
  latency[task.id] = {
    path: task.path,
    goal: task.goal,
    successRate: measured.length ? ok.length / measured.length : null,
    completedRuns: ok.length,
    measuredRuns: measured.length,
    totalMs: summarize(ok.map((r) => r.totalMs)),
    systemMs: summarize(ok.map((r) => r.systemMs)),
    planningMs: summarize(ok.map((r) => r.planningMs)),
    highlightMs: summarize(ok.map((r) => r.highlightMs)),
    verificationMs: summarize(ok.map((r) => r.verificationMs)),
    simulatedUserActionMs: summarize(ok.map((r) => r.userActionMs)),
    qwenInferenceMs: summarize(ok.flatMap((r) => r.qwenLatencyMs)),
    moondreamInferenceMs: summarize(ok.flatMap((r) => r.visionLatencyMs)),
    planningCycles: summarize(ok.map((r) => r.cycles)),
    warmupRun: warm ? { outcome: warm.outcome, totalMs: warm.totalMs, systemMs: warm.systemMs,
      qwenLatencyMs: warm.qwenLatencyMs, visionLatencyMs: warm.visionLatencyMs, modelsLoadedBeforeRun: warm.modelsLoadedBeforeRun } : null,
  };
}

// ── Resource aggregation ────────────────────────────────────────────────────
const blobMap = ollamaBlobToModel((psAtStart ?? []).map((m) => m.name).concat(['qwen2.5-coder:7b', 'moondream:latest']));
const rows = toIntervals(samples, blobMap);
const measuredRuns = runs.filter((r) => !r.warmup);
const sampleGaps = samples.slice(1).map((s, i) => s.t - samples[i].t);
const resources = {
  samplingIntervalMs: summarize(sampleGaps),
  ollamaReportedModels: (psAtStart ?? []).map((m) => ({ name: m.name, sizeMB: Math.round(m.size / 1024 ** 2), sizeVramMB: Math.round((m.size_vram ?? 0) / 1024 ** 2) })),
  inferenceDevice: (psAtStart ?? []).length && (psAtStart ?? []).every((m) => !m.size_vram) ? 'CPU only (Ollama reports size_vram = 0 for every loaded model)' : 'see ollamaReportedModels',
  windows: {
    idleBaseline: aggregate(rows, [baselineWindow]),
    allTaskActivity: aggregate(rows, measuredRuns.map((r) => r.taskWindow)),
    qwenInference: aggregate(rows, measuredRuns.flatMap((r) => r.inferenceWindows.qwen)),
    moondreamInference: aggregate(rows, measuredRuns.flatMap((r) => r.inferenceWindows.moondream)),
    ...Object.fromEntries(tasks.map((t) => [`task:${t.id}`, aggregate(rows, measuredRuns.filter((r) => r.taskId === t.id).map((r) => r.taskWindow))])),
  },
};

const meta = { generatedAt: new Date().toISOString(), machine: machineInfo(), config: { reps, timeoutMs, executionMode: 'local-qwen', idleBaselineMs: IDLE_BASELINE_MS, tasks: tasks.map((t) => t.id) } };
const f1 = writeResult('e2e-latency', { ...meta, latency, runs });
const f2 = writeResult('resources', { ...meta, resources, rawSampleCount: samples.length });

const s = (x) => (x?.mean == null ? '-' : `mean ${Math.round(x.mean)} / median ${Math.round(x.median)} / min ${x.min} / max ${x.max}`);
for (const [id, l] of Object.entries(latency)) {
  console.log(`\n${id} (${l.completedRuns}/${l.measuredRuns} completed)\n  total  ${s(l.totalMs)} ms\n  system ${s(l.systemMs)} ms\n  plan   ${s(l.planningMs)} ms`);
}
for (const [w, a] of Object.entries(resources.windows)) {
  const g = Object.entries(a.perGroup).map(([k, v]) => `${k}: cpu ${v.cpuPct.avg?.toFixed(1)}%/${v.cpuPct.peak?.toFixed(1)}% ram ${Math.round(v.ramMB.avg ?? 0)}MB`).join(' | ');
  console.log(`\n[${w}] n=${a.intervals} system cpu avg ${a.systemCpuPct.avg?.toFixed(1)}% peak ${a.systemCpuPct.peak?.toFixed(1)}% ram avg ${Math.round(a.systemRamUsedMB.avg ?? 0)}MB\n   ${g}`);
}
console.log(`\nResults: ${f1}\n         ${f2}`);
