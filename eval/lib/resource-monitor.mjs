// ScreenPilot evaluation — client resource sampler (Windows).
//
// Samples, about once per second, via Windows' own WMI/CIM counters:
//   • system-wide CPU %            (Win32_PerfFormattedData_PerfOS_Processor _Total)
//   • system RAM in use            (Win32_OperatingSystem total − free)
//   • per process: cumulative CPU time (kernel+user) and working set, for
//       - llama-server.exe  — one per loaded Ollama model; attributed to a
//         model by matching its --model blob against Ollama's own manifests
//       - ollama.exe        — the Ollama server/orchestrator
//       - chrome.exe        — ONLY Playwright's benchmark Chromium (path
//         contains "ms-playwright"); the user's own Chrome is excluded
//
// Per-process CPU % between two samples = Δ(CPU time) / Δ(wall time) /
// logical cores × 100 — i.e. % of the whole machine, as Task Manager shows.
// No GPU figure is collected: this machine's Ollama reports size_vram = 0
// (CPU-only inference); the harness records that report instead.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize } from './metrics.mjs';

const PS_LOOP = (intervalMs) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe' OR Name='ollama.exe' OR Name='chrome.exe'" | ForEach-Object {
    $model = $null
    if ($_.Name -eq 'llama-server.exe' -and $_.CommandLine -match '--model\\s+(\\S+)') { $model = Split-Path $Matches[1] -Leaf }
    [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath; cpu100ns = ([int64]$_.KernelModeTime + [int64]$_.UserModeTime); ws = [int64]$_.WorkingSetSize; model = $model }
  })
  [pscustomobject]@{ t = $t; sysCpu = [double]$cpu; freeKB = [int64]$os.FreePhysicalMemory; totalKB = [int64]$os.TotalVisibleMemorySize; procs = $procs } | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Milliseconds ${intervalMs}
}`;

/** Map llama-server --model blob file names → Ollama model names, from Ollama's own manifests. */
export function ollamaBlobToModel(modelNames) {
  const root = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const map = {};
  for (const name of modelNames) {
    const [repo, tag = 'latest'] = name.split(':');
    const manifest = path.join(root, 'manifests', 'registry.ollama.ai', 'library', repo, tag);
    try {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      for (const layer of m.layers ?? []) {
        if (String(layer.mediaType).includes('image.model') || String(layer.mediaType).includes('image.projector')) {
          map[layer.digest.replace(':', '-')] = name;
        }
      }
    } catch { /* model not in the default library path — left unattributed */ }
  }
  return map;
}

export function startResourceMonitor({ intervalMs = 750 } = {}) {
  const samples = [];
  // Run from a temp .ps1 via -File: passing the multi-line loop through
  // -Command lets Windows argument quoting mangle its embedded double quotes.
  const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mon-')), 'sampler.ps1');
  fs.writeFileSync(scriptFile, PS_LOOP(intervalMs));
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('{')) { try { samples.push(JSON.parse(line)); } catch { /* partial line */ } }
    }
  });
  return {
    samples,
    get stderr() { return stderr; },
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true });
      return samples;
    },
  };
}

/** Group a process record: model name for llama-server, else a fixed group. */
function groupOf(p, blobMap) {
  if (p.name === 'llama-server.exe') return `model:${blobMap[p.model] ?? p.model ?? 'unknown'}`;
  if (p.name === 'ollama.exe') return 'ollama-server';
  if (p.name === 'chrome.exe' && /ms-playwright/i.test(p.path ?? '')) return 'benchmark-chromium';
  return null; // other chrome.exe (user's own browser) — excluded
}

/**
 * Turn raw samples into per-interval rows: for each consecutive sample pair,
 * CPU % per group (of whole machine) and working-set MB per group.
 */
export function toIntervals(samples, blobMap, logicalCores = os.cpus().length) {
  const rows = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dtSec = (b.t - a.t) / 1000;
    if (dtSec <= 0) continue;
    const prevCpu = new Map(a.procs.map((p) => [p.pid, p.cpu100ns]));
    const cpu = {};
    const ramMB = {};
    for (const p of b.procs) {
      const g = groupOf(p, blobMap);
      if (!g) continue;
      ramMB[g] = (ramMB[g] ?? 0) + p.ws / 1024 ** 2;
      const before = prevCpu.get(p.pid);
      if (before == null) continue; // process appeared mid-interval
      const pct = ((p.cpu100ns - before) / 1e7 / dtSec / logicalCores) * 100;
      cpu[g] = (cpu[g] ?? 0) + Math.max(0, pct);
    }
    rows.push({
      t0: a.t, t1: b.t, mid: (a.t + b.t) / 2,
      systemCpuPct: b.sysCpu,
      systemRamUsedMB: (b.totalKB - b.freeKB) / 1024,
      cpu, ramMB,
    });
  }
  return rows;
}

/**
 * Aggregate interval rows that OVERLAP any of `windows` ([{start,end}], epoch
 * ms). Overlap (not midpoint) so a window shorter than one sampling interval
 * still maps to the interval(s) containing it — at the cost of including the
 * rest of that interval, which is why the interval count and the sampling
 * interval are always reported with the numbers.
 * Returns avg/peak CPU % and avg/peak RAM MB, overall and per group.
 */
export function aggregate(rows, windows = null) {
  const inWin = (r) => !windows || windows.some((w) => r.t0 < w.end && r.t1 > w.start);
  const sel = rows.filter(inWin);
  const groups = new Set(sel.flatMap((r) => [...Object.keys(r.cpu), ...Object.keys(r.ramMB)]));
  const stat = (xs) => { const s = summarize(xs); return { avg: s.mean, peak: s.max, n: s.n }; };
  const perGroup = {};
  for (const g of groups) {
    perGroup[g] = {
      cpuPct: stat(sel.map((r) => r.cpu[g] ?? 0)),
      ramMB: stat(sel.map((r) => r.ramMB[g]).filter((v) => v != null)),
    };
  }
  return {
    intervals: sel.length,
    systemCpuPct: stat(sel.map((r) => r.systemCpuPct)),
    systemRamUsedMB: stat(sel.map((r) => r.systemRamUsedMB)),
    perGroup,
  };
}
