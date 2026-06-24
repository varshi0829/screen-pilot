// ScreenPilot - State Manager
// Tracks task progress across the browser session.

export const StateManager = (() => {
  'use strict';

  const STORAGE_KEY  = 'screenpilotTaskState';
  const MAX_HISTORY  = 20;   // cap prevents unbounded session storage growth
  let currentState = null;

  function createTask(goal) {
    currentState = {
      taskId: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      goal,
      currentStep: 0,
      completedSteps: [],
      lastScreenshotTimestamp: 0,
      status: 'ACTIVE',
      currentInstruction: '',
      currentScreenSummary: '',
      currentTarget: null,
      currentConfidence: 0,
      screenContext: null,
      taskPlan: null,
      currentPage: {
        url: '',
        title: ''
      },
      history: [],
      updatedAt: Date.now(),
      startedAt: Date.now()
    };

    return persistAndReturn();
  }

  function getState() {
    return currentState;
  }

  function updateFromAnalysis(analysis, screenshotTimestamp, pageContext = {}) {
    if (!currentState) {
      return null;
    }

    if (
      currentState.currentInstruction &&
      currentState.currentInstruction !== analysis.instruction &&
      currentState.completedSteps[currentState.completedSteps.length - 1] !== currentState.currentInstruction
    ) {
      currentState.completedSteps.push(currentState.currentInstruction);
    }

    currentState.currentStep += 1;
    currentState.currentInstruction = analysis.instruction;
    currentState.currentScreenSummary = analysis.screenSummary;
    currentState.currentTarget = analysis.targetElement;
    currentState.currentConfidence = analysis.confidence;
    if (analysis.screenContext) {
      currentState.screenContext = analysis.screenContext;
    }
    // Always replace the plan when Gemini returns a new one (re-plan on REANALYZE)
    if (analysis.taskPlan) {
      currentState.taskPlan = analysis.taskPlan;
    }
    currentState.lastScreenshotTimestamp = screenshotTimestamp || currentState.lastScreenshotTimestamp;
    currentState.currentPage = {
      url: pageContext.url || currentState.currentPage.url || '',
      title: pageContext.title || currentState.currentPage.title || ''
    };
    currentState.history.push({
      step: currentState.currentStep,
      instruction: analysis.instruction,
      targetElement: analysis.targetElement,
      confidence: analysis.confidence,
      pageContext: currentState.currentPage,
      screenshotTimestamp: currentState.lastScreenshotTimestamp,
      timestamp: Date.now()
    });
    // Cap history to prevent unbounded session storage growth
    if (currentState.history.length > MAX_HISTORY) {
      currentState.history = currentState.history.slice(-MAX_HISTORY);
    }
    currentState.updatedAt = Date.now();
    delete currentState.error;
    delete currentState.abortReason;

    return persistAndReturn();
  }

  function complete(message = 'Task complete') {
    if (!currentState) {
      return null;
    }

    if (
      currentState.currentInstruction &&
      currentState.completedSteps[currentState.completedSteps.length - 1] !== currentState.currentInstruction
    ) {
      currentState.completedSteps.push(currentState.currentInstruction);
    }

    currentState.status = 'COMPLETE';
    currentState.currentInstruction = message;
    currentState.currentConfidence = 1;
    currentState.updatedAt = Date.now();
    currentState.completedAt = Date.now();
    return persistAndReturn();
  }

  function fail(error) {
    if (!currentState) {
      currentState = {
        goal: '',
        currentStep: 0,
        completedSteps: [],
        lastScreenshotTimestamp: 0,
        status: 'ERROR',
        currentInstruction: '',
        currentScreenSummary: '',
        currentTarget: null,
        currentConfidence: 0,
        currentPage: {
          url: '',
          title: ''
        },
        history: [],
        updatedAt: Date.now(),
        error
      };
      return persistAndReturn();
    }

    currentState.status = 'ERROR';
    currentState.error = error;
    currentState.updatedAt = Date.now();
    return persistAndReturn();
  }

  function abort(reason = 'User cancelled') {
    if (!currentState) {
      return null;
    }

    currentState.status = 'ABORTED';
    currentState.abortReason = reason;
    currentState.updatedAt = Date.now();
    return persistAndReturn();
  }

  async function restore() {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    currentState = result[STORAGE_KEY] || null;
    return currentState;
  }

  async function reset() {
    currentState = null;
    await chrome.storage.session.remove(STORAGE_KEY);
  }

  function isActive() {
    return currentState?.status === 'ACTIVE';
  }

  // Called by background.js before reanalysis to record that the current
  // instruction was executed by the user. This ensures Gemini sees
  // "Completed: X" on the next call rather than "Last instruction: X",
  // preventing it from repeating the same step.
  function markCurrentInstructionCompleted() {
    if (!currentState?.currentInstruction) return Promise.resolve(null);
    const last = currentState.completedSteps[currentState.completedSteps.length - 1];
    if (last !== currentState.currentInstruction) {
      currentState.completedSteps.push(currentState.currentInstruction);
      currentState.updatedAt = Date.now();
      return persistAndReturn();
    }
    return Promise.resolve(currentState);
  }

  // Called by content.js when a plan step is executed locally (no Gemini call).
  // Advances the plan index and records the step in completedSteps/history.
  function advancePlanStep(stepIndex, instruction) {
    if (!currentState) return null;

    const plan = currentState.taskPlan;
    if (plan) {
      // Mark the step we just finished as done
      const prevIdx = plan.currentStepIndex;
      if (prevIdx >= 0 && prevIdx < plan.steps.length) {
        plan.steps[prevIdx].status = 'done';
      }
      plan.currentStepIndex = stepIndex;
    }

    if (
      currentState.currentInstruction &&
      currentState.completedSteps[currentState.completedSteps.length - 1] !== currentState.currentInstruction
    ) {
      currentState.completedSteps.push(currentState.currentInstruction);
    }

    currentState.currentStep += 1;
    currentState.currentInstruction = instruction;
    currentState.updatedAt = Date.now();

    currentState.history.push({
      step: currentState.currentStep,
      instruction,
      source: 'plan',
      timestamp: Date.now()
    });
    if (currentState.history.length > MAX_HISTORY) {
      currentState.history = currentState.history.slice(-MAX_HISTORY);
    }

    return persistAndReturn();
  }

  async function persistAndReturn() {
    await chrome.storage.session.set({
      [STORAGE_KEY]: currentState
    });

    return currentState;
  }

  return {
    createTask,
    getState,
    updateFromAnalysis,
    markCurrentInstructionCompleted,
    advancePlanStep,
    complete,
    fail,
    abort,
    restore,
    reset,
    isActive
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StateManager;
}
