import { ScreenshotService } from './services/screenshot-service.js';
import { StateManager } from './services/state-manager.js';
import { VisionService } from './services/vision-service.js';
import { TelemetryService } from './services/telemetry-service.js';

const DEBUG = false;

let initPromise = null;
let activeAnalysis = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[Background] Unhandled error:', err);
      sendResponse({ success: false, error: err?.message || 'Unexpected background error.' });
    });
  return true;
});

async function handleMessage(message, sender) {
  await ensureInitialized();

  if (!StateManager.getState()) {
    await StateManager.restore();
  }

  switch (message.type) {
    case 'ANALYZE_GOAL':
      return analyzeGoal(message, sender);
    case 'REANALYZE':
      return reanalyzeGoal(message, sender);
    case 'ADVANCE_PLAN_STEP':
      return advancePlanStep(message);
    case 'GET_STATE':
      return { success: true, state: StateManager.getState() };
    case 'COMPLETE_TASK':
      return completeTask(message);
    case 'ABORT_TASK':
      return abortTask(message);
    case 'TELEMETRY_EVENT':
      return handleTelemetryEvent(message);
    case 'GET_ANALYTICS':
      return { success: true, analytics: await TelemetryService.getAnalytics() };
    case 'CLEAR_ANALYTICS':
      await TelemetryService.clear();
      return { success: true };
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

async function analyzeGoal(message, sender) {
  await StateManager.createTask(message.goal);
  const taskId = StateManager.getState().taskId;
  TelemetryService.startTask(taskId, message.goal);
  activeAnalysis = null;
  return queueVisionCycle({
    sender,
    goal: message.goal,
    pageContext: buildPageContext(message),
    reason: 'initial-analysis',
    forceNew: true,
  });
}

async function reanalyzeGoal(message, sender) {
  const taskState = StateManager.getState();
  if (!taskState?.goal || taskState.status !== 'ACTIVE') {
    return { success: false, error: 'No active ScreenPilot task to continue.' };
  }
  // Detect plan fallbacks: plan step failed in DOM and fell through to Gemini
  const isPlanFallback = typeof message.reason === 'string' && message.reason.startsWith('plan-');
  if (isPlanFallback && taskState.taskId) {
    TelemetryService.recordFallback(taskState.taskId);
  }
  return queueVisionCycle({
    sender,
    goal: taskState.goal,
    pageContext: buildPageContext(message, taskState.currentPage),
    reason: message.reason || 'reanalyze',
    forceNew: false,
  });
}

function queueVisionCycle({ sender, goal, pageContext, reason, forceNew }) {
  const taskState = StateManager.getState();
  const signature = `${taskState?.goal || goal}|${pageContext.url || ''}|${pageContext.title || ''}`;

  if (!forceNew && activeAnalysis?.signature === signature && activeAnalysis?.taskState?.status === 'ACTIVE') {
    return activeAnalysis.promise;
  }

  const promise = runVisionCycle({ goal, sender, pageContext, reason }).finally(() => {
    if (activeAnalysis?.promise === promise) activeAnalysis = null;
  });

  activeAnalysis = { signature, promise, taskState };
  return promise;
}

async function runVisionCycle({ goal, sender, pageContext, reason }) {
  const t0     = Date.now();
  const taskId = StateManager.getState()?.taskId;
  log('cycle start — reason:', reason);

  const screenshot = await ScreenshotService.captureVisibleTab(sender.tab?.windowId);
  log(`screenshot: ${Date.now() - t0}ms | ${Math.round((screenshot.image?.length || 0) / 1024)}KB`);

  const validation = ScreenshotService.validateScreenshot(screenshot);
  if (!validation.valid) {
    await StateManager.fail(validation.error);
    if (taskId) TelemetryService.completeTask(taskId, 'failed', validation.error);
    return { success: false, error: validation.error, state: StateManager.getState() };
  }

  const tAnalyze = Date.now();
  const analysis = await VisionService.analyzeScreenshot({
    screenshot,
    goal,
    pageContext,
    taskState: StateManager.getState(),
  });
  const geminiLatencyMs = Date.now() - tAnalyze;
  log(`analysis: ${geminiLatencyMs}ms | success: ${analysis.success}`);

  if (taskId) {
    TelemetryService.recordGeminiCall(taskId, { latencyMs: geminiLatencyMs, success: analysis.success });
  }

  if (!analysis.success) {
    await StateManager.fail(analysis.error);
    if (taskId) TelemetryService.completeTask(taskId, 'failed', analysis.error);
    return { success: false, error: analysis.error, retryable: analysis.retryable, state: StateManager.getState() };
  }

  if (taskId && analysis.taskPlan?.steps?.length) {
    TelemetryService.recordPlanGenerated(taskId, analysis.taskPlan.steps.length);
  }

  if (analysis.complete) {
    await StateManager.complete(analysis.instruction || 'Task complete');
    if (taskId) TelemetryService.completeTask(taskId, 'completed', 'task-complete');
    return buildSuccessResponse(analysis, true);
  }

  await StateManager.updateFromAnalysis(analysis, screenshot.timestamp, pageContext);
  log(`total cycle: ${Date.now() - t0}ms`);
  return buildSuccessResponse(analysis, false);
}

function buildSuccessResponse(analysis, complete) {
  return {
    success: true,
    complete,
    screenSummary:  analysis.screenSummary,
    currentRegion:  analysis.currentRegion,
    currentStep:    analysis.currentStep,
    targetElement:  analysis.targetElement,
    candidates:     analysis.candidates || [],
    instruction:    analysis.instruction,
    confidence:     analysis.confidence,
    screenContext:  analysis.screenContext || null,
    state:          StateManager.getState(),
  };
}

async function advancePlanStep(message) {
  const taskState = StateManager.getState();
  if (!taskState || taskState.status !== 'ACTIVE') {
    return { success: false, error: 'No active task.' };
  }
  const state = await StateManager.advancePlanStep(message.stepIndex, message.instruction);
  // Succeeded: counts as one attempt + one success
  if (taskState.taskId) TelemetryService.recordPlanStep(taskState.taskId, true);
  return { success: true, state };
}

async function completeTask(message) {
  const taskState = StateManager.getState();
  await StateManager.complete(message.message || 'Task complete');
  if (taskState?.taskId) {
    TelemetryService.completeTask(taskState.taskId, 'completed', 'user-marked-complete');
  }
  return { success: true, state: StateManager.getState() };
}

async function abortTask(message) {
  const taskState = StateManager.getState();
  await StateManager.abort(message.reason || 'User cancelled');
  if (taskState?.taskId) {
    TelemetryService.completeTask(taskState.taskId, 'aborted', message.reason || 'user-cancelled');
  }
  activeAnalysis = null;
  return { success: true, state: StateManager.getState() };
}

function handleTelemetryEvent(message) {
  const taskId = StateManager.getState()?.taskId;
  switch (message.event) {
    case 'CACHE_HIT':
      TelemetryService.recordCacheHit().catch(() => {});
      break;
    case 'PLAN_STEP_FAILED':
      if (taskId) TelemetryService.recordPlanStep(taskId, false);
      break;
  }
  return { success: true };
}

function buildPageContext(message, fallback = {}) {
  return {
    url:   message.url   || fallback.url   || '',
    title: message.title || fallback.title || '',
  };
}

async function ensureInitialized() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init() {
  await StateManager.restore();
  const state = StateManager.getState();
  if (state?.status && ['COMPLETE', 'ABORTED'].includes(state.status)) {
    await StateManager.reset();
  }
}

function log(...args) {
  if (DEBUG) console.log('[ScreenPilot]', ...args);
}

ensureInitialized();
