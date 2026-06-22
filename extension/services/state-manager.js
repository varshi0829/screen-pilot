// ScreenPilot - State Manager
// Tracks task progress across the browser session.

export const StateManager = (() => {
  'use strict';

  const STORAGE_KEY = 'screenpilotTaskState';
  let currentState = null;

  function createTask(goal) {
    currentState = {
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
