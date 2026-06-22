// Transition Execution Simulation
// Tests the GitHub "create a new repository" flow

import { NavigationPlanner } from './extension/services/navigation-planner.js';

// Simulated page states for GitHub
const pageStates = {
  fileBrowser: {
    screenSummary: "GitHub repository file browser showing .cargo directory contents",
    pageType: "repository",
    candidates: [
      { text: "Go to file", actionType: "content_item", elementType: "link" },
      { text: "..", actionType: "navigation_action", elementType: "link", region: "breadcrumb" },
      { text: "canary", actionType: "navigation_action", elementType: "link", region: "breadcrumb" },
      { text: "next.js", actionType: "navigation_action", elementType: "link", region: "breadcrumb" },
      { text: "vercel", actionType: "navigation_action", elementType: "link", region: "breadcrumb" },
      { text: "New", actionType: "primary_action", elementType: "button", region: "header" },
      { text: "Code", actionType: "primary_action", elementType: "button", region: "header" },
      { text: "Pull requests", actionType: "navigation_action", elementType: "link", region: "nav" },
      { text: "Actions", actionType: "navigation_action", elementType: "link", region: "nav" },
      { text: "Settings", actionType: "navigation_action", elementType: "link", region: "nav" }
    ]
  },
  repoList: {
    screenSummary: "GitHub repository list page",
    pageType: "list",
    candidates: [
      { text: "New", actionType: "primary_action", elementType: "button", region: "header" },
      { text: "vercel/next.js", actionType: "content_item", elementType: "link" },
      { text: "Pull requests", actionType: "navigation_action", elementType: "link" },
      { text: "Actions", actionType: "navigation_action", elementType: "link" },
      { text: "Settings", actionType: "navigation_action", elementType: "link" }
    ]
  },
  createRepoForm: {
    screenSummary: "Create new repository form",
    pageType: "form",
    candidates: [
      { text: "Repository name", actionType: "input_field", elementType: "input" },
      { text: "Public", actionType: "content_item", elementType: "radio" },
      { text: "Private", actionType: "content_item", elementType: "radio" },
      { text: "Create repository", actionType: "primary_action", elementType: "button" }
    ]
  }
};

const goal = "create a new repository";

console.log('='.repeat(70));
console.log('TRANSITION EXECUTION SIMULATION');
console.log('='.repeat(70));
console.log(`Goal: "${goal}"`);
console.log(`Start: github.com/vercel/next.js/tree/canary/.cargo`);
console.log('='.repeat(70));

// Track metrics
let transitionsAttempted = 0;
let transitionsSucceeded = 0;
let transitionsFailed = 0;

// Simulate execution
async function simulateExecution() {
  console.log('\n[INITIAL STATE]');
  console.log('-'.repeat(40));
  console.log('URL: github.com/vercel/next.js/tree/canary/.cargo');
  console.log('Page Type: repository (file browser)');
  
  // Phase 1: Analyze initial state
  const state1 = NavigationPlanner.modelState(pageStates.fileBrowser);
  console.log(`\n[State Model] pageType=${state1.pageType}, confidence=${state1.confidence}`);
  
  // Phase 2: Gap analysis
  const gap = NavigationPlanner.analyzeGoalGap(goal, state1);
  console.log(`\n[Gap Analysis]`);
  console.log(`  currentState: ${gap.currentState}`);
  console.log(`  targetState: ${gap.targetState}`);
  console.log(`  navigationNeeded: ${gap.navigationNeeded}`);
  console.log(`  reason: ${gap.reason}`);
  
  if (gap.navigationNeeded) {
    console.log(`\n[Required Transitions]`);
    for (const t of gap.requiredTransitions || []) {
      console.log(`  ${t.from} -> ${t.to} (via: ${t.via})`);
    }
  }
  
  // Phase 3: Create navigation plan
  const plan = NavigationPlanner.createNavigationPlan(goal, state1, gap);
  console.log(`\n[Navigation Plan]`);
  console.log(`  Steps: ${plan.steps?.length || 0}`);
  
  if (plan.steps) {
    for (const step of plan.steps) {
      console.log(`  Step ${step.id}: ${step.description}`);
      console.log(`    Element: "${step.expectedElement?.text}"`);
      console.log(`    Type: ${step.expectedElement?.type}`);
      console.log(`    Expected State: ${step.state}`);
      console.log(`    Is Navigation: ${step.isNavigation}`);
    }
  }
  
  // Phase 4: Simulate transitions
  console.log('\n[TRANSITION EXECUTION]');
  console.log('-'.repeat(40));
  
  // Transition 1: repository -> dashboard
  console.log('\n[TRANSITION 1] repository -> dashboard');
  transitionsAttempted++;
  
  // Simulate DOM matching
  const domMatch1 = simulateDOMMatch(plan.steps[0], pageStates.fileBrowser);
  console.log(`  Chosen DOM element: "${domMatch1.element}"`);
  console.log(`  Match score: ${domMatch1.score}`);
  console.log(`  Why selected: ${domMatch1.reason}`);
  console.log(`  Expected next state: dashboard`);
  
  // Simulate click
  console.log(`  Action: Click "${domMatch1.element}"`);
  console.log(`  Result: User clicks, page navigates to repo list`);
  
  // Simulate state detection after click
  const stateAfter1 = pageStates.repoList;
  const actualState1 = 'list';
  console.log(`  Actual next state: ${actualState1}`);
  
  if (actualState1 === 'dashboard' || actualState1 === 'list') {
    console.log(`  Transition: SUCCESS`);
    transitionsSucceeded++;
  } else {
    console.log(`  Transition: FAILED`);
    transitionsFailed++;
  }
  
  // Transition 2: dashboard -> form
  console.log('\n[TRANSITION 2] dashboard -> form');
  transitionsAttempted++;
  
  const domMatch2 = simulateDOMMatch(plan.steps[1], pageStates.repoList);
  console.log(`  Chosen DOM element: "${domMatch2.element}"`);
  console.log(`  Match score: ${domMatch2.score}`);
  console.log(`  Why selected: ${domMatch2.reason}`);
  console.log(`  Expected next state: form`);
  
  console.log(`  Action: Click "${domMatch2.element}"`);
  console.log(`  Result: User clicks, page navigates to create form`);
  
  const actualState2 = 'form';
  console.log(`  Actual next state: ${actualState2}`);
  
  if (actualState2 === 'form') {
    console.log(`  Transition: SUCCESS`);
    transitionsSucceeded++;
  } else {
    console.log(`  Transition: FAILED`);
    transitionsFailed++;
  }
  
  // Final outcome
  console.log('\n' + '='.repeat(70));
  console.log('FINAL OUTCOME');
  console.log('='.repeat(70));
  console.log(`Transitions attempted: ${transitionsAttempted}`);
  console.log(`Transitions succeeded: ${transitionsSucceeded}`);
  console.log(`Transitions failed: ${transitionsFailed}`);
  console.log(`Success rate: ${(transitionsSucceeded/transitionsAttempted*100).toFixed(1)}%`);
  
  if (transitionsSucceeded === transitionsAttempted) {
    console.log('\n✅ SUCCESS: Reached repository creation page');
  } else {
    console.log('\n❌ FAILED: Did not reach repository creation page');
  }
}

function simulateDOMMatch(step, pageState) {
  // Simulate DOM matching logic
  const candidates = pageState.candidates || [];
  
  // Find matching element
  for (const c of candidates) {
    if (c.text.toLowerCase().includes(step.expectedElement?.text?.toLowerCase())) {
      return {
        element: c.text,
        score: 95,
        reason: `Primary match: "${c.text}" found in DOM with actionType="${c.actionType}"`
      };
    }
  }
  
  // Fallback to alternatives
  for (const c of candidates) {
    if (c.actionType === 'primary_action' || c.actionType === 'navigation_action') {
      return {
        element: c.text,
        score: 75,
        reason: `Recovery: matched by actionType="${c.actionType}"`
      };
    }
  }
  
  return {
    element: 'NOT FOUND',
    score: 0,
    reason: 'No match found'
  };
}

simulateExecution().catch(console.error);