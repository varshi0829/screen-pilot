import { ScreenshotService }  from './services/screenshot-service.js';
import { StateManager }       from './services/state-manager.js';
import { VisionService }      from './services/vision-service.js';
import { TelemetryService }   from './services/telemetry-service.js';
import { MemoryService }       from './services/memory-service.js';
import { RateLimiterService }  from './services/rate-limiter-service.js';
import { ValidationService }   from './services/validation-service.js';
import { NavigationPlanner }  from './services/navigation-planner.js';

const DEBUG = false;

let initPromise    = null;
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
  if (!StateManager.getState()) await StateManager.restore();

  switch (message.type) {
    case 'ANALYZE_GOAL':           return analyzeGoal(message, sender);
    case 'REANALYZE':              return reanalyzeGoal(message, sender);
    case 'ADVANCE_PLAN_STEP':      return advancePlanStep(message);
    case 'GET_STATE':              return { success: true, state: StateManager.getState() };
    case 'COMPLETE_TASK':          return completeTask(message);
    case 'ABORT_TASK':             return abortTask(message);
    case 'GET_SCREEN_EXPLANATION': return getScreenExplanation(message, sender);
    case 'ASK_QUESTION':           return askQuestion(message, sender);
    case 'TELEMETRY_EVENT':        return handleTelemetryEvent(message);
    case 'GET_ANALYTICS':          return { success: true, analytics: await TelemetryService.getAnalytics() };
    case 'CLEAR_ANALYTICS':        await TelemetryService.clear(); return { success: true };
    case 'GET_MEMORY_STATS':         return { success: true, stats: await MemoryService.getStats() };
    case 'CLEAR_MEMORY':             await MemoryService.clear(); return { success: true };
    case 'GET_RATE_USAGE':           return { success: true, usage: await RateLimiterService.getUsage() };
    case 'GET_VALIDATION_REPORT':    return { success: true, report: await ValidationService.generateReport() };
    case 'GET_BENCHMARKS':           return { success: true, benchmarks: ValidationService.getBenchmarks() };
    case 'CLEAR_VALIDATION':         await ValidationService.clear(); return { success: true };
    case 'RUN_BENCHMARK':            return runBenchmark(message, sender);
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

let _bgCallSeq = 0;

async function analyzeGoal(message, sender) {
  // If this is a recursive call from _buildMemoryResponse (empty workflow),
  // skip the memory check to prevent infinite loops.
  if (message._skipMemory) {
    return queueVisionCycle({
      sender,
      goal:             message.goal,
      pageContext:      buildPageContext(message),
      enterpriseContext: message.enterpriseContext || null,
      reason:           'initial-analysis',
      forceNew:         true,
    });
  }

  await StateManager.createTask(message.goal);
  const taskId = StateManager.getState().taskId;
  TelemetryService.startTask(taskId, message.goal);
  ValidationService.startRun(taskId, message.goal, { url: message.url || '' });

  // Record enterprise context detection (sent by content.js)
  const ec = message.enterpriseContext || null;
  if (ec) {
    TelemetryService.recordEnterpriseContext(taskId, {
      application: ec.application,
      detected:    !!ec.application && ec.confidence >= 0.5,
    });
    ValidationService.recordEvent('ENTERPRISE_CONTEXT', { application: ec.application, module: ec.module, confidence: ec.confidence });
  }

  // Phase 3: Predictive Navigation — check memory before calling Gemini
  const memHit = await MemoryService.findWorkflow(message.goal);
  if (memHit && memHit.confidence >= 0.85) {
    log(`[Memory] Hit — confidence=${memHit.confidence.toFixed(2)} type=${memHit.matchType}`);
    TelemetryService.recordMemoryHit(taskId);
    ValidationService.recordEvent('MEMORY_HIT', { confidence: memHit.confidence, matchType: memHit.matchType });
    activeAnalysis = null;
    return _buildMemoryResponse(memHit.workflow, memHit.confidence, message, sender);
  }
  ValidationService.recordEvent('MEMORY_MISS', {});

  activeAnalysis = null;
  return queueVisionCycle({
    sender,
    goal:             message.goal,
    pageContext:      buildPageContext(message),
    enterpriseContext: ec,
    reason:           'initial-analysis',
    forceNew:         true,
  });
}

async function reanalyzeGoal(message, sender) {
  const taskState = StateManager.getState();
  if (!taskState?.goal || taskState.status !== 'ACTIVE') {
    return { success: false, error: 'No active ScreenPilot task to continue.' };
  }
  const isPlanFallback = typeof message.reason === 'string' && message.reason.startsWith('plan-');
  if (isPlanFallback && taskState.taskId) TelemetryService.recordFallback(taskState.taskId);

  // Mark the current instruction as completed before reanalysis.
  // Any reanalysis means the user has taken an action (click, form input, navigation).
  // This ensures Gemini sees "Completed: X" on the next call and advances
  // rather than repeating the same instruction.
  await StateManager.markCurrentInstructionCompleted();

  return queueVisionCycle({
    sender,
    goal:             taskState.goal,
    pageContext:      buildPageContext(message, taskState.currentPage),
    enterpriseContext: message.enterpriseContext || null,
    reason:           message.reason || 'reanalyze',
    forceNew:         false,
  });
}

function queueVisionCycle({ sender, goal, pageContext, enterpriseContext, reason, forceNew }) {
  const taskState = StateManager.getState();
  const signature = `${taskState?.goal || goal}|${pageContext.url || ''}|${pageContext.title || ''}`;

  if (!forceNew && activeAnalysis?.signature === signature && activeAnalysis?.taskState?.status === 'ACTIVE') {
    console.log(`[Dedup] queueVisionCycle reused — signature="${signature.slice(0, 60)}" reason=${reason}`);
    return activeAnalysis.promise;
  }

  const promise = runVisionCycle({ goal, sender, pageContext, enterpriseContext, reason }).finally(() => {
    if (activeAnalysis?.promise === promise) activeAnalysis = null;
  });
  activeAnalysis = { signature, promise, taskState };
  return promise;
}

async function runVisionCycle({ goal, sender, pageContext, enterpriseContext, reason }) {
  const t0     = Date.now();
  const taskId = StateManager.getState()?.taskId;
  console.log(`[CALL #${++_bgCallSeq}] reason=${reason}`);
  log('cycle start — reason:', reason);

  // Capture progress snapshot before calling Gemini so we can measure advancement.
  const _snap = {
    instruction: StateManager.getState()?.currentInstruction || '(none)',
    completed:   [...(StateManager.getState()?.completedSteps || [])],
    url:         StateManager.getState()?.currentPage?.url || '(none)',
  };
  console.log(
    `[Progress] START` +
    ` goal="${goal}"` +
    ` prevInstruction="${_snap.instruction}"` +
    ` completedSteps=[${_snap.completed.join(' → ') || 'none'}]` +
    ` prevUrl="${_snap.url}"` +
    ` currentUrl="${pageContext.url || '(none)'}"`
  );

  // Phase 4: Check extension-side rate limit before capturing screenshot
  const canProceed = await RateLimiterService.canProceed();
  if (!canProceed) {
    const usage = await RateLimiterService.getUsage();
    const msg   = usage.perMinute.remaining === 0
      ? `Rate limit: ${usage.perMinute.limit} requests/minute reached. Try again in a moment.`
      : `Daily limit of ${usage.perDay.limit} requests reached for today.`;
    await StateManager.fail(msg);
    if (taskId) TelemetryService.completeTask(taskId, 'failed', 'rate-limit-extension');
    return { success: false, error: msg, state: StateManager.getState() };
  }

  const screenshot = await ScreenshotService.captureVisibleTab(sender.tab?.windowId);
  log(`screenshot: ${Date.now() - t0}ms`);

  const validation = ScreenshotService.validateScreenshot(screenshot);
  if (!validation.valid) {
    await StateManager.fail(validation.error);
    if (taskId) TelemetryService.completeTask(taskId, 'failed', validation.error);
    return { success: false, error: validation.error, state: StateManager.getState() };
  }

  // Record the request in the persistent rate limiter
  await RateLimiterService.recordRequest();

  ValidationService.recordEvent('GEMINI_CALL', { mode: 'navigate' });
  const tAnalyze  = Date.now();
  const analysis  = await VisionService.analyzeScreenshot({
    screenshot,
    goal,
    pageContext,
    enterpriseContext,
    taskState: StateManager.getState(),
  });
  const latencyMs = Date.now() - tAnalyze;
  log(`analysis: ${latencyMs}ms | success: ${analysis.success}`);

  if (taskId) TelemetryService.recordGeminiCall(taskId, { latencyMs, success: analysis.success });
  ValidationService.recordEvent('GEMINI_RESPONSE', { latencyMs, success: analysis.success });

  if (analysis.success) {
    const _newInstruction = analysis.instruction || '(none)';
    const _repeated       = _newInstruction === _snap.instruction && _snap.completed.includes(_snap.instruction);
    const _advanced       = _newInstruction !== _snap.instruction;
    const _urlChanged     = pageContext.url && _snap.url !== '(none)' && pageContext.url !== _snap.url;
    console.log(
      `[Progress] RESULT` +
      ` prevInstruction="${_snap.instruction}"` +
      ` newInstruction="${_newInstruction}"` +
      ` progressMade=${_advanced}` +
      ` repeated=${_repeated}` +
      ` urlChanged=${_urlChanged}` +
      ` reason=${_repeated ? 'WARN:same-instruction-already-completed' : _advanced ? 'advanced' : 'unchanged'}`
    );
  }

  if (!analysis.success) {
    await StateManager.fail(analysis.error);
    if (taskId) TelemetryService.completeTask(taskId, 'failed', analysis.error);
    ValidationService.endRun('failed', analysis.error).catch(() => {});
    return { success: false, error: analysis.error, retryable: analysis.retryable, state: StateManager.getState() };
  }

  if (taskId && analysis.taskPlan?.steps?.length) {
    TelemetryService.recordPlanGenerated(taskId, analysis.taskPlan.steps.length);
    ValidationService.recordEvent('PLAN_GENERATED', { stepCount: analysis.taskPlan.steps.length });
  }

  // Phase 5: Use 8-step architecture fields directly from backend
  // The backend now returns: blockers, navigationRequired, transitions, nextAction, urlChanged, domChanged, pageTypeChanged
  const raw = analysis.raw || {};
  
  // STEP 4: Blocker Detection - check if blocked before navigation
  if (raw.blockers?.length > 0) {
    const blockerMessage = raw.blockers[0];
    log(`[8-Step] BLOCKER DETECTED: ${blockerMessage}`);
    await StateManager.fail(blockerMessage);
    if (taskId) TelemetryService.completeTask(taskId, 'blocked', blockerMessage);
    ValidationService.endRun('blocked', blockerMessage);
    return { success: false, error: blockerMessage, blocked: true, state: StateManager.getState() };
  }

  // STEP 3: Gap Analysis - use transitions from backend if available
  const navigationRequired = raw.navigationRequired ?? false;
  const transitions = raw.transitions || [];
  
  if (navigationRequired && transitions.length > 0) {
    log(`[8-Step] GAP DETECTED: transitions=${transitions.join(' -> ')}`);
    TelemetryService.recordNavigationTransition(taskId, transitions[0], transitions[transitions.length - 1]);
  }

  // STEP 5: Route Execution - use nextAction directly from backend
  if (raw.nextAction && !analysis.instruction) {
    analysis.instruction = raw.nextAction;
    log(`[8-Step] NEXT ACTION: ${raw.nextAction}`);
  }

  // STEP 6: State Verification - check if previous action resulted in state change
  // Only on reanalysis: verify URL/DOM/pageType changed
  const isReanalysis = reason && (reason.includes('reanalyze') || reason.includes('click') || reason.includes('advance'));
  if (isReanalysis) {
    const urlChanged = raw.urlChanged ?? false;
    const domChanged = raw.domChanged ?? false;
    const pageTypeChanged = raw.pageTypeChanged ?? false;
    const replan = raw.replan ?? false;
    
    log(`[8-Step] VERIFY: urlChanged=${urlChanged}, domChanged=${domChanged}, pageTypeChanged=${pageTypeChanged}, replan=${replan}`);
    
    if (replan || (!urlChanged && !domChanged && !pageTypeChanged)) {
      // State didn't change - need to replan
      log(`[8-Step] REPLAN: previous action did not result in state change`);
      TelemetryService.recordRecovery(taskId, false);
      // Continue with new analysis - the backend will provide new nextAction
    } else {
      TelemetryService.recordRecovery(taskId, true);
    }
  }

  // Legacy NavigationPlanner fallback - only if 8-step fields not available
  if (!raw.application && !raw.pageType) {
    const stateModel = NavigationPlanner.modelState(analysis);
    const goalGap = NavigationPlanner.analyzeGoalGap(goal, stateModel);

    log(`[Navigation] stateModel: pageType=${stateModel.pageType}, confidence=${stateModel.confidence}`);
    log(`[Navigation] goalGap: current=${goalGap.currentState}, target=${goalGap.targetState}, needed=${goalGap.navigationNeeded}`);

    if (goalGap.navigationNeeded) {
      log(`[Navigation] gap detected: ${goalGap.reason}`);
      TelemetryService.recordNavigationTransition(taskId, goalGap.currentState, goalGap.targetState);

      const navPlan = NavigationPlanner.createNavigationPlan(goal, stateModel, goalGap);
      if (navPlan?.steps?.length) {
        analysis.taskPlan = navPlan;
        log(`[Navigation] multi-step plan: ${navPlan.steps.length} steps`);
      }
    } else {
      TelemetryService.recordNavigationSuccess(taskId, stateModel.pageType, 'target');
    }
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

// ─── MEMORY: SYNTHETIC RESPONSE ──────────────────────────────────────────────

async function _buildMemoryResponse(workflow, confidence, message, sender) {
  const taskId    = StateManager.getState()?.taskId;
  const firstStep = workflow.steps[0];
  if (!firstStep) return analyzeGoal({ ...message, _skipMemory: true }, sender);

  // Construct a taskPlan from the remembered workflow
  const taskPlan = {
    steps: workflow.steps.map(s => ({
      id:              s.id || 0,
      description:     s.description,
      expectedElement: s.expectedElement || s.element || { text: s.description, type: 'button', region: 'main_content' },
      status:          'pending',
      fromMemory:      true,
    })),
    currentStepIndex: 0,
    planVersion:      1,
    createdAt:        Date.now(),
    fromMemory:       true,
  };

  // Build a synthetic analysis object for StateManager.updateFromAnalysis
  const syntheticAnalysis = {
    instruction:    firstStep.description,
    screenSummary:  `Executing remembered workflow (${workflow.completionCount} previous completions): "${workflow.goal}"`,
    screenContext:  null,
    currentRegion:  firstStep.expectedElement?.region || firstStep.element?.region || 'main_content',
    currentStep:    firstStep.description,
    targetElement:  firstStep.expectedElement || firstStep.element || { text: firstStep.description, type: 'button' },
    candidates:     [],
    confidence,
    taskPlan,
    complete:       false,
  };

  const pageContext = buildPageContext(message);
  await StateManager.updateFromAnalysis(syntheticAnalysis, Date.now(), pageContext);

  log(`[Memory] Synthetic plan: ${taskPlan.steps.length} steps`);
  return buildSuccessResponse(syntheticAnalysis, false);
}

// ─── PLAN ADVANCEMENT ─────────────────────────────────────────────────────────

function buildSuccessResponse(analysis, complete) {
  const raw = analysis.raw || {};
  return {
    success:       true,
    complete,
    fromMemory:    analysis.taskPlan?.fromMemory || false,
    screenSummary: analysis.screenSummary,
    currentRegion: analysis.currentRegion,
    currentStep:   analysis.currentStep,
    targetElement: analysis.targetElement,
    candidates:    analysis.candidates || [],
    instruction:   analysis.instruction,
    confidence:    analysis.confidence,
    screenContext: analysis.screenContext || null,
    state:         StateManager.getState(),
    // 8-step fields pass-through
    application:   raw.application,
    pageType:      raw.pageType,
    authenticated: raw.authenticated,
    blockers:      raw.blockers,
    navigationRequired: raw.navigationRequired,
    transitions:  raw.transitions,
    nextAction:    raw.nextAction,
    urlChanged:    raw.urlChanged,
    domChanged:    raw.domChanged,
    pageTypeChanged: raw.pageTypeChanged,
    replan:        raw.replan,
  };
}

async function advancePlanStep(message) {
  const taskState = StateManager.getState();
  if (!taskState || taskState.status !== 'ACTIVE') {
    return { success: false, error: 'No active task.' };
  }
  const state = await StateManager.advancePlanStep(message.stepIndex, message.instruction);
  if (taskState.taskId) TelemetryService.recordPlanStep(taskState.taskId, true);
  return { success: true, state };
}

async function completeTask(message) {
  const taskState = StateManager.getState();

  // Phase 2: Save workflow to memory on successful completion
  if (taskState?.goal && taskState?.taskPlan?.steps?.length) {
    const steps = taskState.taskPlan.steps
      .filter(s => s.status === 'done' || s.expectedElement?.text)
      .map(s => ({
        id:              s.id,
        description:     s.description,
        expectedElement: s.expectedElement,
        urlPattern:      taskState.currentPage?.url || '',
      }));

    MemoryService.saveWorkflow({
      goal:             taskState.goal,
      steps,
      geminiCalls:      0,    // will be filled by telemetry on flush
      completionStatus: 'completed',
      application:      taskState.screenContext?.application || null,
    }).catch(() => {});
  }

  await StateManager.complete(message.message || 'Task complete');
  if (taskState?.taskId) TelemetryService.completeTask(taskState.taskId, 'completed', 'user-marked-complete');
  ValidationService.endRun('completed').catch(() => {});
  return { success: true, state: StateManager.getState() };
}

async function abortTask(message) {
  const taskState = StateManager.getState();
  await StateManager.abort(message.reason || 'User cancelled');
  if (taskState?.taskId) TelemetryService.completeTask(taskState.taskId, 'aborted', message.reason || 'user-cancelled');
  ValidationService.endRun('aborted', message.reason || 'user-cancelled').catch(() => {});
  activeAnalysis = null;
  return { success: true, state: StateManager.getState() };
}

// ─── EXPLAIN MY SCREEN ────────────────────────────────────────────────────────

async function getScreenExplanation(message, sender) {
  const taskState = StateManager.getState();
  const ctx       = taskState?.screenContext;
  const age       = taskState?.updatedAt ? Date.now() - taskState.updatedAt : Infinity;

  if (ctx && age < 30_000) {
    log('getScreenExplanation: serving from cache');
    return { success: true, screenContext: ctx, fromCache: true };
  }

  const screenshot = await ScreenshotService.captureVisibleTab(sender.tab?.windowId);
  const validation = ScreenshotService.validateScreenshot(screenshot);
  if (!validation.valid) return { success: false, error: validation.error };

  const result = await VisionService.explainScreen({
    screenshot,
    pageContext: buildPageContext(message),
  });
  if (!result.success) return { success: false, error: result.error };
  return { success: true, screenContext: result.screenContext, fromCache: false };
}

// ─── SCREEN Q&A ──────────────────────────────────────────────────────────────

async function askQuestion(message, sender) {
  const question = message.question?.trim();
  if (!question) return { success: false, error: 'Question is required.' };

  const taskState = StateManager.getState();
  const ctx       = taskState?.screenContext;
  if (ctx) {
    const local = tryLocalAnswer(question, ctx);
    if (local) {
      log('askQuestion: answered locally from ScreenContext');
      return { success: true, answer: local, confidence: 0.85, fromCache: true };
    }
  }

  const screenshot = await ScreenshotService.captureVisibleTab(sender.tab?.windowId);
  const validation = ScreenshotService.validateScreenshot(screenshot);
  if (!validation.valid) return { success: false, error: validation.error };

  return VisionService.askQuestion({
    screenshot,
    question,
    pageContext: buildPageContext(message),
  });
}

function tryLocalAnswer(question, ctx) {
  const q = question.toLowerCase();
  if (/what.*(app|application|site|website|tool|software|platform)/.test(q)) {
    return ctx.application ? `You are on ${ctx.application}.` : null;
  }
  if (/what.*(page|screen|view).*is this|what am i looking at|where am i/.test(q) || q === 'what is this?') {
    return ctx.screenSummary || null;
  }
  if (/what.*(can i do|do here|available|options|actions)/.test(q)) {
    return ctx.visibleActions?.length ? 'Available actions: ' + ctx.visibleActions.join(', ') + '.' : null;
  }
  if (/what.*(type|kind).*(page|screen|view)/.test(q)) {
    const app = ctx.application ? ` in ${ctx.application}` : '';
    return ctx.pageType ? `This is a ${ctx.pageType} page${app}.` : null;
  }
  return null;
}

// ─── TELEMETRY ───────────────────────────────────────────────────────────────

function handleTelemetryEvent(message) {
  const taskId = StateManager.getState()?.taskId;
  const detail = message.detail || {};
  switch (message.event) {
    case 'CACHE_HIT':
      TelemetryService.recordCacheHit().catch(() => {});
      ValidationService.recordEvent('CACHE_HIT', {});
      break;
    case 'PLAN_STEP_FAILED':
      if (taskId) TelemetryService.recordPlanStep(taskId, false);
      ValidationService.recordEvent('PLAN_STEP_FAILED', detail);
      break;
    case 'PLAN_STEP_RECOVERED': {
      if (taskId) TelemetryService.recordPlanStep(taskId, true);
      if (taskId) TelemetryService.recordRecovery(taskId, true);
      const tier = detail.recoveryTier === 'alternatives' ? 'PLAN_STEP_RECOVERY_1'
        : detail.recoveryTier === 'semantic'              ? 'PLAN_STEP_RECOVERY_2'
        : 'PLAN_STEP_PRIMARY';
      ValidationService.recordEvent(tier, detail);
      break;
    }
    case 'RECOVERY_ATTEMPTED':
      if (taskId) TelemetryService.recordRecovery(taskId, false);
      break;
  }
  return { success: true };
}

// ─── BENCHMARK ───────────────────────────────────────────────────────────────

async function runBenchmark(message, sender) {
  const benchmarks = ValidationService.getBenchmarks();
  const benchmark  = benchmarks.find(b => b.id === message.benchmarkId);
  if (!benchmark) return { success: false, error: `Unknown benchmark: ${message.benchmarkId}` };

  const tabId = message.tabId || sender.tab?.id;
  if (!tabId) return { success: false, error: 'No target tab specified.' };

  // Inject content script if not already present, then trigger goal
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'RUN_GOAL', goal: benchmark.goal });
  } catch {
    // Content script not injected — inject it first
    await chrome.scripting.executeScript({ target: { tabId }, files: ['services/enterprise-context-service.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/dom-matcher.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles/widget.css'] });
    await new Promise(r => setTimeout(r, 200));
    await chrome.tabs.sendMessage(tabId, { type: 'RUN_GOAL', goal: benchmark.goal });
  }

  return { success: true, benchmark };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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
  // Periodic memory cleanup — remove stale entries older than 30 days
  MemoryService.cleanup?.().catch(() => {});
}

function log(...args) {
  if (DEBUG) console.log('[ScreenPilot]', ...args);
}

ensureInitialized();
