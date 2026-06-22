// ScreenPilot - Navigation Planner
// Generic state-transition reasoning for multi-step navigation.
// No application-specific logic - works with any software.
//
// What it does:
// 1. State Modeling - produces page state from Gemini response
// 2. Goal Gap Analysis - determines if goal is achievable
// 3. Navigation Discovery - finds navigation primitives
// 4. Multi-Step Planning - creates plans with intermediate states

export const NavigationPlanner = (() => {
  'use strict';

  // ─── GENERIC PAGE TYPES ────────────────────────────────────────────────────────
  // Software-agnostic page type classification
  const PAGE_TYPES = {
    DASHBOARD: 'dashboard',
    DETAIL: 'detail_page',
    SETTINGS: 'settings',
    FORM: 'form',
    LIST: 'list',
    REPOSITORY: 'repository',
    EDITOR: 'editor',
    UNKNOWN: 'unknown',
  };

  // Navigation primitives - generic element types that enable state transitions
  const NAVIGATION_PRIMITIVES = {
    GLOBAL_NAV: 'global_navigation',
    MENU: 'menu',
    BREADCRUMB: 'breadcrumb',
    SIDEBAR: 'sidebar',
    CREATE_BUTTON: 'create_button',
    HEADER_ACTION: 'header_action',
    WORKSPACE_SWITCHER: 'workspace_switcher',
    PROFILE_MENU: 'profile_menu',
    TAB: 'tab',
    DROPDOWN: 'dropdown',
  };

  // ─── STATE MODELING ────────────────────────────────────────────────────────

  /**
   * Produce state model from Gemini response.
   * @returns { pageType, currentActivity, availableActions, navigationElements, globalActions, confidence }
   */
  function modelState(geminiResponse) {
    const parsed = geminiResponse?.raw || geminiResponse;
    if (!parsed) return buildUnknownState();

    const pageType = classifyPageType(parsed);
    const currentActivity = parsed.screenSummary || '';
    const availableActions = extractActions(parsed);
    const navigationElements = discoverNavigationElements(parsed);
    const globalActions = discoverGlobalActions(parsed);
    const confidence = parsed.confidence || 0;

    return {
      pageType,
      currentActivity,
      availableActions,
      navigationElements,
      globalActions,
      confidence,
    };
  }

  function classifyPageType(parsed) {
    const pageType = parsed.pageType?.toLowerCase() || '';
    const summary = (parsed.screenSummary || '').toLowerCase();
    const candidates = parsed.candidates || [];

    // Match against generic page types
    if (pageType.includes('dashboard') || summary.includes('dashboard')) return PAGE_TYPES.DASHBOARD;
    if (pageType.includes('detail') || summary.includes('detail view') || summary.includes('details')) return PAGE_TYPES.DETAIL;
    if (pageType.includes('settings') || pageType.includes('config') || summary.includes('settings')) return PAGE_TYPES.SETTINGS;
    if (pageType.includes('form') || summary.includes('form') || summary.includes('input')) return PAGE_TYPES.FORM;
    if (pageType.includes('list') || summary.includes('list') || summary.includes('table')) return PAGE_TYPES.LIST;
    if (pageType.includes('editor') || summary.includes('edit') || summary.includes('code')) return PAGE_TYPES.EDITOR;
    if (pageType.includes('repository') || summary.includes('repository') || summary.includes('repo')) return PAGE_TYPES.REPOSITORY;

    // Infer from candidates - if mostly navigation elements, likely a list/dashboard
    const navCount = candidates.filter(c => isNavigationCandidate(c)).length;
    const actionCount = candidates.filter(c => isActionCandidate(c)).length;
    if (navCount > actionCount && navCount > 2) return PAGE_TYPES.LIST;

    return PAGE_TYPES.UNKNOWN;
  }

  function extractActions(parsed) {
    const candidates = parsed.candidates || [];
    return candidates
      .filter(c => c.text && c.actionType)
      .map(c => ({
        text: c.text,
        actionType: c.actionType,
        elementType: c.elementType,
        region: c.region,
        confidence: c.confidence,
      }));
  }

  function discoverNavigationElements(parsed) {
    const candidates = parsed.candidates || [];
    return candidates
      .filter(c => isNavigationCandidate(c))
      .map(c => ({
        text: c.text,
        elementType: c.elementType || 'link',
        region: c.region,
        navType: classifyNavigationType(c),
        confidence: c.confidence || 0.5,
      }));
  }

  function isNavigationCandidate(candidate) {
    const text = (candidate.text || '').toLowerCase();
    const region = (candidate.region || '').toLowerCase();
    const actionType = candidate.actionType || '';

    return (
      region.includes('navigation') ||
      region.includes('sidebar') ||
      region.includes('header') ||
      region.includes('breadcrumb') ||
      actionType === 'navigation_action' ||
      text.includes('menu') ||
      text.includes('tab') ||
      text.includes('nav') ||
      text.includes('back') ||
      text.includes('home')
    );
  }

  function isActionCandidate(candidate) {
    const actionType = candidate.actionType || '';
    return (
      actionType === 'primary_action' ||
      actionType === 'content_item' ||
      actionType === 'input_field'
    );
  }

  function classifyNavigationType(candidate) {
    const text = (candidate.text || '').toLowerCase();
    const region = (candidate.region || '').toLowerCase();

    if (region.includes('breadcrumb') || text.includes('›') || text.includes('>')) return NAVIGATION_PRIMITIVES.BREADCRUMB;
    if (text.includes('create') || text.includes('new') || text.includes('add')) return NAVIGATION_PRIMITIVES.CREATE_BUTTON;
    if (region.includes('sidebar') || region.includes('side')) return NAVIGATION_PRIMITIVES.SIDEBAR;
    if (region.includes('header') || region.includes('top')) return NAVIGATION_PRIMITIVES.HEADER_ACTION;
    if (text.includes('menu') || text.includes('dropdown')) return NAVIGATION_PRIMITIVES.MENU;
    if (text.includes('workspace') || text.includes('switch') || text.includes('org')) return NAVIGATION_PRIMITIVES.WORKSPACE_SWITCHER;
    if (text.includes('profile') || text.includes('account') || text.includes('user')) return NAVIGATION_PRIMITIVES.PROFILE_MENU;
    if (text.includes('tab')) return NAVIGATION_PRIMITIVES.TAB;

    return NAVIGATION_PRIMITIVES.GLOBAL_NAV;
  }

  function discoverGlobalActions(parsed) {
    const navElements = discoverNavigationElements(parsed);
    return navElements.filter(n => n.navType !== NAVIGATION_PRIMITIVES.CREATE_BUTTON);
  }

  function buildUnknownState() {
    return {
      pageType: PAGE_TYPES.UNKNOWN,
      currentActivity: '',
      availableActions: [],
      navigationElements: [],
      globalActions: [],
      confidence: 0,
    };
  }

  // ─── GOAL GAP ANALYSIS ───────────────────────────────────────────────────

  /**
   * Determine if goal is achievable from current state.
   * @returns { currentState, targetState, gap, navigationNeeded }
   */
  function analyzeGoalGap(goal, currentState, targetContext = {}) {
    const goalNormalized = normalizeGoal(goal);
    const currentActivity = (currentState.currentActivity || '').toLowerCase();

    // Check if goal is directly achievable
    const isDirectlyAchievable = checkDirectAchievement(goalNormalized, currentState);
    if (isDirectlyAchievable) {
      return {
        currentState: currentState.pageType,
        targetState: inferTargetState(goalNormalized),
        gap: null,
        navigationNeeded: false,
        reason: 'Goal achievable from current state',
      };
    }

    // Goal requires navigation
    const targetState = inferTargetState(goalNormalized);
    const gap = identifyGap(currentState.pageType, targetState);

    return {
      currentState: currentState.pageType,
      targetState,
      gap,
      navigationNeeded: true,
      reason: `Need to navigate from ${currentState.pageType} to ${targetState}`,
      requiredTransitions: computeTransitions(currentState.pageType, targetState),
    };
  }

  function normalizeGoal(goal) {
    return goal.toLowerCase().replace(/['"()]/g, '').replace(/\s+/g, ' ').trim();
  }

  function checkDirectAchievement(goalNorm, state) {
    const actions = state.availableActions || [];
    const navElements = state.navigationElements || [];

    // Check if any action directly achieves the goal
    for (const action of actions) {
      if (matchesGoal(goalNorm, action.text)) {
        return true;
      }
    }

    // Check if any navigation element leads to goal
    for (const nav of navElements) {
      if (matchesGoal(goalNorm, nav.text)) {
        return true;
      }
    }

    return false;
  }

  function matchesGoal(goal, elementText) {
    if (!elementText || !goal) return false;
    const text = elementText.toLowerCase();
    return (
      goal.includes(text) ||
      text.includes(goal) ||
      fuzzyMatch(goal, text)
    );
  }

  function fuzzyMatch(a, b) {
    const wordsA = a.split(' ').filter(w => w.length > 2);
    const wordsB = b.split(' ').filter(w => w.length > 2);
    const matches = wordsA.filter(w => wordsB.includes(w));
    return matches.length >= Math.min(wordsA.length, wordsB.length) * 0.5;
  }

  function inferTargetState(goalNorm) {
    // Generic state inference - no app-specific logic
    if (goalNorm.includes('create') || goalNorm.includes('new') || goalNorm.includes('add')) {
      return PAGE_TYPES.FORM;
    }
    if (goalNorm.includes('settings') || goalNorm.includes('config') || goalNorm.includes('preferences')) {
      return PAGE_TYPES.SETTINGS;
    }
    if (goalNorm.includes('list') || goalNorm.includes('all') || goalNorm.includes('browse')) {
      return PAGE_TYPES.LIST;
    }
    if (goalNorm.includes('detail') || goalNorm.includes('view') || goalNorm.includes('open')) {
      return PAGE_TYPES.DETAIL;
    }
    if (goalNorm.includes('edit') || goalNorm.includes('update') || goalNorm.includes('modify')) {
      return PAGE_TYPES.EDITOR;
    }
    if (goalNorm.includes('dashboard') || goalNorm.includes('home') || goalNorm.includes('overview')) {
      return PAGE_TYPES.DASHBOARD;
    }

    return PAGE_TYPES.UNKNOWN;
  }

  function identifyGap(fromState, toState) {
    if (fromState === toState) return null;
    return `Navigate from ${fromState} to ${toState}`;
  }

  function computeTransitions(fromState, toState) {
    // Generic transition paths - no app-specific logic
    const transitions = [];

    // Common paths
    if (fromState === PAGE_TYPES.LIST && toState === PAGE_TYPES.FORM) {
      transitions.push({ from: PAGE_TYPES.LIST, to: PAGE_TYPES.FORM, via: 'create_button' });
    }
    if (fromState === PAGE_TYPES.LIST && toState === PAGE_TYPES.DETAIL) {
      transitions.push({ from: PAGE_TYPES.LIST, to: PAGE_TYPES.DETAIL, via: 'content_item' });
    }
    if (fromState === PAGE_TYPES.DETAIL && toState === PAGE_TYPES.EDITOR) {
      transitions.push({ from: PAGE_TYPES.DETAIL, to: PAGE_TYPES.EDITOR, via: 'edit_action' });
    }
    if (fromState === PAGE_TYPES.DETAIL && toState === PAGE_TYPES.FORM) {
      transitions.push({ from: PAGE_TYPES.DETAIL, to: PAGE_TYPES.FORM, via: 'edit_button' });
    }
    if (fromState === PAGE_TYPES.UNKNOWN && toState !== PAGE_TYPES.UNKNOWN) {
      transitions.push({ from: fromState, to: toState, via: 'navigation' });
    }

    // Dashboard as hub - most apps have dashboard as entry point
    if (toState !== PAGE_TYPES.DASHBOARD && fromState !== PAGE_TYPES.DASHBOARD) {
      transitions.push({ from: fromState, to: PAGE_TYPES.DASHBOARD, via: 'home' });
      transitions.push({ from: PAGE_TYPES.DASHBOARD, to: toState, via: 'dashboard_action' });
    }

    return transitions;
  }

  // ─── MULTI-STEP PLANNING ───────────────────────────────────────────────────

  /**
   * Create a multi-step plan with navigation states.
   * @returns { steps: [], currentStepIndex: 0 }
   */
  function createNavigationPlan(goal, currentState, gapAnalysis) {
    if (!gapAnalysis.navigationNeeded) {
      // Direct plan - goal achievable from current state
      return createDirectPlan(goal, currentState);
    }

    // Multi-step plan with navigation
    return createMultiStepPlan(goal, currentState, gapAnalysis);
  }

  function createDirectPlan(goal, state) {
    const candidates = state.availableActions || [];
    const bestAction = candidates.find(c => c.confidence > 0.5) || candidates[0];

    if (!bestAction) {
      return { steps: [], currentStepIndex: 0 };
    }

    return {
      steps: [
        {
          id: 1,
          description: `Click "${bestAction.text}"`,
          expectedElement: { text: bestAction.text, type: bestAction.elementType },
          state: 'target',
        },
      ],
      currentStepIndex: 0,
    };
  }

  function createMultiStepPlan(goal, state, gapAnalysis) {
    const steps = [];
    let stepId = 1;

    // Step 1: Navigate to intermediate state if needed
    if (gapAnalysis.requiredTransitions?.length > 0) {
      const transitions = gapAnalysis.requiredTransitions;

      for (const transition of transitions) {
        const navElement = findNavigationForTransition(state, transition);
        if (navElement) {
          steps.push({
            id: stepId++,
            description: `Navigate via "${navElement.text}"`,
            expectedElement: { text: navElement.text, type: navElement.elementType },
            state: transition.to,
            isNavigation: true,
          });
        }
      }
    }

    // Final step: achieve goal
    const targetAction = state.availableActions?.find(c => c.confidence > 0.5);
    if (targetAction) {
      steps.push({
        id: stepId++,
        description: `Click "${targetAction.text}"`,
        expectedElement: { text: targetAction.text, type: targetAction.elementType },
        state: 'target',
        isNavigation: false,
      });
    }

    return { steps, currentStepIndex: 0 };
  }

  function findNavigationForTransition(state, transition) {
    const navElements = state.navigationElements || [];
    const globalActions = state.globalActions || [];
    const allNav = [...navElements, ...globalActions];

    // Find element that matches the transition type
    for (const nav of allNav) {
      if (matchesTransitionType(nav, transition.via)) {
        return nav;
      }
    }

    // Fallback: return first navigation element
    return allNav[0];
  }

  function matchesTransitionType(navElement, transitionType) {
    const text = (navElement.text || '').toLowerCase();
    const navType = navElement.navType || '';

    switch (transitionType) {
      case 'create_button':
        return navType === NAVIGATION_PRIMITIVES.CREATE_BUTTON || text.includes('new') || text.includes('create');
      case 'home':
        return navType === NAVIGATION_PRIMITIVES.GLOBAL_NAV || text.includes('home') || text.includes('dashboard');
      case 'breadcrumb':
        return navType === NAVIGATION_PRIMITIVES.BREADCRUMB;
      case 'sidebar':
        return navType === NAVIGATION_PRIMITIVES.SIDEBAR;
      default:
        return true;
    }
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────────

  return {
    modelState,
    analyzeGoalGap,
    createNavigationPlan,
    PAGE_TYPES,
    NAVIGATION_PRIMITIVES,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NavigationPlanner;
}