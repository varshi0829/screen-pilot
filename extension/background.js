import { ScreenshotService } from './services/screenshot-service.js';
import { StateManager } from './services/state-manager.js';
import { VisionService } from './services/vision-service.js';

const DEBUG = false;

let apiKey = null;
let initPromise = null;
let activeAnalysis = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[ScreenPilot Background] Message received:', message.type, 'from tab', sender.tab?.id);
  
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error('[ScreenPilot Background] Error handling message:', error);
      log('Unhandled background error:', error);
      sendResponse({
        success: false,
        error: error?.message || 'Unexpected background error.'
      });
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
    case 'GET_STATE':
      return { success: true, state: StateManager.getState() };
    case 'COMPLETE_TASK':
      await StateManager.complete(message.message || 'Task complete');
      return { success: true, state: StateManager.getState() };
    case 'ABORT_TASK':
      await StateManager.abort(message.reason || 'User cancelled');
      activeAnalysis = null;
      return { success: true, state: StateManager.getState() };
    case 'GET_API_KEY':
      return { success: true, hasKey: Boolean(apiKey) };
    case 'SET_API_KEY':
      return setApiKey(message.key);
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

async function analyzeGoal(message, sender) {
  console.log('[Background] analyzeGoal called');
  console.log('[Background] API key present:', !!apiKey);
  console.log('[Background] Message:', message);

  if (!apiKey) {
    console.error('[Background] No API key configured');
    return { success: false, error: 'API key not configured. Open the extension popup and save your Gemini key.' };
  }

  console.log('[Background] Creating task for goal:', message.goal);
  log('Goal:', message.goal);
  await StateManager.createTask(message.goal);
  activeAnalysis = null;

  console.log('[Background] Queueing vision cycle');
  return queueVisionCycle({
    sender,
    goal: message.goal,
    pageContext: buildPageContext(message),
    reason: 'initial-analysis',
    forceNew: true
  });
}

async function reanalyzeGoal(message, sender) {
  const taskState = StateManager.getState();

  if (!taskState?.goal || taskState.status !== 'ACTIVE') {
    return { success: false, error: 'No active ScreenPilot task to continue.' };
  }

  return queueVisionCycle({
    sender,
    goal: taskState.goal,
    pageContext: buildPageContext(message, taskState.currentPage),
    reason: message.reason || 'reanalyze',
    forceNew: false
  });
}

function queueVisionCycle({ sender, goal, pageContext, reason, forceNew }) {
  const taskState = StateManager.getState();
  const signature = `${taskState?.goal || goal}|${pageContext.url || ''}|${pageContext.title || ''}`;

  if (!forceNew && activeAnalysis?.signature === signature && activeAnalysis?.taskState?.status === 'ACTIVE') {
    return activeAnalysis.promise;
  }

  const promise = runVisionCycle({ goal, sender, pageContext, reason })
    .finally(() => {
      if (activeAnalysis?.promise === promise) {
        activeAnalysis = null;
      }
    });

  activeAnalysis = {
    signature,
    promise,
    taskState
  };

  return promise;
}

async function runVisionCycle({ goal, sender, pageContext, reason }) {
  const t0 = Date.now();
  console.log(`[Perf BG] cycle start — reason: ${reason}`);

  const tShot = Date.now();
  const screenshot = await ScreenshotService.captureVisibleTab(sender.tab?.windowId);
  console.log(`[Perf BG] screenshot: ${Date.now() - tShot}ms | size: ${Math.round((screenshot.image?.length || 0) / 1024)}KB`);

  const validation = ScreenshotService.validateScreenshot(screenshot);
  console.log('[Background] Screenshot validation:', validation);

  if (!validation.valid) {
    console.error('[Background] Screenshot validation failed:', validation.error);
    await StateManager.fail(validation.error);
    return { success: false, error: validation.error, state: StateManager.getState() };
  }

  const tGemini = Date.now();
  const analysis = await VisionService.analyzeScreenshot({
    screenshot,
    goal,
    pageContext,
    taskState: StateManager.getState()
  });
  console.log(`[Perf BG] gemini: ${Date.now() - tGemini}ms | success: ${analysis.success}`);
  if (!analysis.success) console.error('[Background] Analysis error:', analysis.error);

  log('Vision response:', analysis.success ? {
    screenSummary: analysis.screenSummary,
    currentStep: analysis.currentStep,
    targetElement: analysis.targetElement,
    instruction: analysis.instruction,
    confidence: analysis.confidence,
    complete: analysis.complete,
    attempts: analysis.attempts
  } : analysis);

  if (!analysis.success) {
    await StateManager.fail(analysis.error);
    return {
      success: false,
      error: analysis.error,
      retryable: analysis.retryable,
      state: StateManager.getState()
    };
  }

  if (analysis.complete) {
    await StateManager.complete(analysis.instruction || 'Task complete');
    return buildSuccessResponse(analysis, true);
  }

  await StateManager.updateFromAnalysis(analysis, screenshot.timestamp, pageContext);
  console.log(`[Perf BG] total cycle: ${Date.now() - t0}ms`);
  return buildSuccessResponse(analysis, false);
}

function buildSuccessResponse(analysis, complete) {
  return {
    success: true,
    complete,
    screenSummary: analysis.screenSummary,
    currentRegion: analysis.currentRegion,
    currentStep:   analysis.currentStep,
    targetElement: analysis.targetElement,
    candidates:    analysis.candidates || [],
    instruction:   analysis.instruction,
    confidence:    analysis.confidence,
    state: StateManager.getState()
  };
}

async function setApiKey(key) {
  apiKey = key?.trim() || null;
  VisionService.init(apiKey);
  await chrome.storage.local.set({ apiKey });
  return { success: true, hasKey: Boolean(apiKey) };
}

function buildPageContext(message, fallback = {}) {
  return {
    url:   message.url   || fallback.url   || '',
    title: message.title || fallback.title || ''
  };
}

async function ensureInitialized() {
  if (!initPromise) {
    initPromise = init();
  }

  return initPromise;
}

async function init() {
  const [{ apiKey: storedApiKey }, restoredState] = await Promise.all([
    chrome.storage.local.get('apiKey'),
    StateManager.restore()
  ]);

  if (storedApiKey) {
    apiKey = storedApiKey;
    VisionService.init(storedApiKey);
  }

  if (restoredState?.status && ['COMPLETE', 'ABORTED'].includes(restoredState.status)) {
    await StateManager.reset();
  }
}

function log(...args) {
  if (DEBUG) {
    console.log('[ScreenPilot]', ...args);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('apiKey');
  if (!existing.apiKey) {
    await chrome.storage.local.set({ apiKey: 'AIzaSyB7scUV9sZ-SVax-kjE-Ex1OfdRWotx87g' });
  }
});

ensureInitialized();
