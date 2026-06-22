// Navigation Planner Test
// Tests the planner for: Goal = "create a new repository" on GitHub file browser

import { NavigationPlanner } from './extension/services/navigation-planner.js';

// Simulated Gemini response for: github.com/vercel/next.js/tree/canary/.cargo
const mockGeminiResponse = {
  screenSummary: "GitHub repository file browser showing .cargo directory contents",
  currentRegion: "main_content",
  currentStep: "Viewing files in .cargo folder",
  candidates: [
    { text: "Go to file", elementType: "link", region: "file_list", actionType: "content_item" },
    { text: "..", elementType: "link", region: "breadcrumb", actionType: "navigation_action" },
    { text: "canary", elementType: "link", region: "breadcrumb", actionType: "navigation_action" },
    { text: "next.js", elementType: "link", region: "breadcrumb", actionType: "navigation_action" },
    { text: "vercel", elementType: "link", region: "breadcrumb", actionType: "navigation_action" },
    { text: "New", elementType: "button", region: "header", actionType: "primary_action" },
    { text: "Code", elementType: "button", region: "header", actionType: "primary_action" },
    { text: "Pull requests", elementType: "link", region: "nav", actionType: "navigation_action" },
    { text: "Actions", elementType: "link", region: "nav", actionType: "navigation_action" },
    { text: "Settings", elementType: "link", region: "nav", actionType: "navigation_action" }
  ],
  targetElement: { text: "", type: "button" },
  instruction: "No clear action can be taken from this page.",
  confidence: 0.05,
  pageType: "repository"
};

const goal = "create a new repository";

console.log('='.repeat(60));
console.log('NAVIGATION PLANNER EXECUTION TRACE');
console.log('='.repeat(60));
console.log(`Goal: "${goal}"`);
console.log(`Starting URL: github.com/vercel/next.js/tree/canary/.cargo`);
console.log('='.repeat(60));

// 1. State Modeling
console.log('\n[1] STATE MODEL');
console.log('-'.repeat(40));
const stateModel = NavigationPlanner.modelState(mockGeminiResponse);
console.log(JSON.stringify(stateModel, null, 2));

// 2. Gap Analysis
console.log('\n[2] GAP ANALYSIS');
console.log('-'.repeat(40));
const goalGap = NavigationPlanner.analyzeGoalGap(goal, stateModel);
console.log(JSON.stringify(goalGap, null, 2));

// 3. Navigation Plan
console.log('\n[3] NAVIGATION PLAN');
console.log('-'.repeat(40));
const navPlan = NavigationPlanner.createNavigationPlan(goal, stateModel, goalGap);
console.log(JSON.stringify(navPlan, null, 2));

// 4. Would be injected into taskPlan
console.log('\n[4] PLAN INJECTION');
console.log('-'.repeat(40));
console.log('taskPlan.steps:', navPlan.steps?.length || 0);
console.log('Would be stored in StateManager:', navPlan.steps?.length > 0);
console.log('Would be consumed by content.js:', navPlan.steps?.length > 0);

// 5. Expected click actions
console.log('\n[5] EXPECTED CLICK ACTIONS');
console.log('-'.repeat(40));
if (navPlan.steps) {
  navPlan.steps.forEach((step, i) => {
    console.log(`Step ${i + 1}: ${step.description}`);
    console.log(`  - Element: ${step.expectedElement?.text}`);
    console.log(`  - Type: ${step.expectedElement?.type}`);
    console.log(`  - Is Navigation: ${step.isNavigation}`);
  });
}

console.log('\n' + '='.repeat(60));
console.log('BEFORE vs AFTER COMPARISON');
console.log('='.repeat(60));
console.log('BEFORE (without NavigationPlanner):');
console.log('  - taskPlan: single step from Gemini');
console.log('  - Would fail to find "New" button from file browser');
console.log('');
console.log('AFTER (with NavigationPlanner):');
console.log('  - taskPlan: multi-step with navigation');
console.log('  - Navigates to repository page first');
console.log('  - Then clicks "New" button');
console.log('='.repeat(60));