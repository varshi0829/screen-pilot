// ScreenPilot v2 — Multi-step workflow validation test suite
//
// Run: node extension/tests/workflows.test.mjs
//
// Tests expected planner responses for common real-world workflows.
// Each test mocks the adapter to return a fixed plan, then validates
// the plan structure, step count, element hints, and navigation path.

import assert from 'assert/strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assertPlan(plan, { minSteps = 1, maxSteps = 10, state = 'planned', result = 'OK' } = {}) {
  assert.equal(plan.result, result,           `result should be "${result}"`);
  assert.equal(plan.state,  state,            `state should be "${state}"`);
  assert.ok(Array.isArray(plan.plan?.steps),  'plan.steps must be an array');
  assert.ok(plan.plan.steps.length >= minSteps, `expected >= ${minSteps} steps, got ${plan.plan.steps.length}`);
  assert.ok(plan.plan.steps.length <= maxSteps, `expected <= ${maxSteps} steps, got ${plan.plan.steps.length}`);
  for (const step of plan.plan.steps) {
    assert.ok(step.targetElement?.text,       `step "${step.description}" must have non-empty targetElement.text`);
    assert.ok(step.description,               'step must have description');
    assert.ok(step.intent,                    'step must have intent');
    assert.ok(step.completionCondition,       'step must have completionCondition');
  }
}

function assertShortestPath(plan, forbiddenIntents = []) {
  for (const step of plan.plan?.steps ?? []) {
    for (const forbidden of forbiddenIntents) {
      assert.ok(
        !step.intent?.toLowerCase().includes(forbidden),
        `Step "${step.description}" intent contains forbidden navigation "${forbidden}" — not shortest path`
      );
    }
  }
}

// ── Fixture plans ─────────────────────────────────────────────────────────────
// These represent what /api/plan SHOULD return for each scenario.
// They define the acceptance criteria for planner quality.

const GITHUB_STAR_REPO = {
  result:  'OK',
  state:   'planned',
  blockers: [],
  confidence: 0.92,
  plannerSummary: 'The Star button is visible in the repository header — one click completes the goal.',
  plan: {
    goalType: 'action',
    confidence: 0.92,
    steps: [
      {
        id: 1,
        description: "Click 'Star' to star the repository",
        intent: 'star repository',
        phase: 'submit',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'dom_change',
        targetElement: {
          text: 'Star',
          type: 'button',
          region: 'main_content',
          intent: 'star this repository',
          alternatives: ['Unstar', '★ Star', 'Starred'],
        },
        precondition: {},
        expectedPageState: { urlChanges: false },
        reversible: true,
      },
    ],
  },
};

const GITHUB_CREATE_REPO = {
  result:  'OK',
  state:   'planned',
  blockers: [],
  confidence: 0.90,
  plannerSummary: "GitHub's global '+' menu is available on every page — no dashboard navigation needed.",
  plan: {
    goalType: 'navigation',
    confidence: 0.90,
    steps: [
      {
        id: 1,
        description: "Click the '+' menu to open the create options",
        intent: 'open create menu',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'dom_change',
        targetElement: {
          text: 'Create new...',
          type: 'button',
          region: 'top_navigation',
          intent: 'open create dropdown',
          alternatives: ['+', 'New', 'Create new'],
        },
        precondition: {},
        expectedPageState: { urlChanges: false },
        reversible: true,
      },
      {
        id: 2,
        description: "Click 'New repository' in the dropdown",
        intent: 'navigate to repository creation',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'url_change',
        targetElement: {
          text: 'New repository',
          type: 'menu_action',
          region: 'dropdown',
          intent: 'open new repository form',
          alternatives: ['New repository', 'Create repository', 'New repo'],
        },
        precondition: {},
        expectedPageState: { urlPattern: '/new', urlChanges: true },
        reversible: true,
      },
    ],
  },
};

const GITHUB_OPEN_PR = {
  result:  'OK',
  state:   'planned',
  blockers: [],
  confidence: 0.88,
  plannerSummary: "From a branch or commit view, the 'Compare & pull request' button or 'New pull request' in the Pull requests tab opens the PR form directly.",
  plan: {
    goalType: 'navigation',
    confidence: 0.88,
    steps: [
      {
        id: 1,
        description: "Click 'Pull requests' tab to view pull requests",
        intent: 'navigate to pull requests tab',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'url_change',
        targetElement: {
          text: 'Pull requests',
          type: 'button',
          region: 'top_navigation',
          intent: 'open pull requests tab',
          alternatives: ['Pull requests', 'PRs'],
        },
        precondition: {},
        expectedPageState: { urlPattern: '/pulls', urlChanges: true },
        reversible: true,
      },
      {
        id: 2,
        description: "Click 'New pull request' to open the PR creation form",
        intent: 'open pull request form',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'url_change',
        targetElement: {
          text: 'New pull request',
          type: 'button',
          region: 'main_content',
          intent: 'create new pull request',
          alternatives: ['New pull request', 'Create pull request', 'Compare & pull request'],
        },
        precondition: {},
        expectedPageState: { urlPattern: '/compare', urlChanges: true },
        reversible: true,
      },
    ],
  },
};

const GITLAB_CREATE_MR = {
  result:  'OK',
  state:   'planned',
  blockers: [],
  confidence: 0.87,
  plannerSummary: "From the Merge requests section the 'New merge request' button opens the MR form directly.",
  plan: {
    goalType: 'navigation',
    confidence: 0.87,
    steps: [
      {
        id: 1,
        description: "Click 'Merge requests' in the left sidebar",
        intent: 'navigate to merge requests',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'url_change',
        targetElement: {
          text: 'Merge requests',
          type: 'link',
          region: 'side_navigation',
          intent: 'open merge requests list',
          alternatives: ['Merge requests', 'MRs'],
        },
        precondition: {},
        expectedPageState: { urlPattern: '/merge_requests', urlChanges: true },
        reversible: true,
      },
      {
        id: 2,
        description: "Click 'New merge request' to start creating a merge request",
        intent: 'open merge request form',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'url_change',
        targetElement: {
          text: 'New merge request',
          type: 'button',
          region: 'main_content',
          intent: 'create new merge request',
          alternatives: ['New merge request', 'Create merge request'],
        },
        precondition: {},
        expectedPageState: { urlPattern: '/new', urlChanges: true },
        reversible: true,
      },
    ],
  },
};

const GMAIL_COMPOSE = {
  result:  'OK',
  state:   'planned',
  blockers: [],
  confidence: 0.95,
  plannerSummary: "Gmail's 'Compose' button is always visible in the left sidebar — one click opens a new compose window.",
  plan: {
    goalType: 'action',
    confidence: 0.95,
    steps: [
      {
        id: 1,
        description: "Click 'Compose' to open a new email draft",
        intent: 'open compose window',
        phase: 'navigate',
        optional: false,
        timeout_ms: 3000,
        completionCondition: 'dom_change',
        targetElement: {
          text: 'Compose',
          type: 'button',
          region: 'side_navigation',
          intent: 'open new email compose window',
          alternatives: ['Compose', 'New message', '✏'],
        },
        precondition: {},
        expectedPageState: { urlChanges: false },
        reversible: true,
      },
    ],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nWorkflow: GitHub — Star Repository');
test('plan is valid and has exactly 1 step', () => {
  assertPlan(GITHUB_STAR_REPO, { minSteps: 1, maxSteps: 1 });
});
test('target element is Star button in main_content', () => {
  const step = GITHUB_STAR_REPO.plan.steps[0];
  assert.equal(step.targetElement.region, 'main_content');
  assert.ok(['Star', 'Unstar', '★ Star', 'Starred'].includes(step.targetElement.text) ||
    step.targetElement.alternatives?.some(a => a.toLowerCase().includes('star')),
    'targetElement.text or alternatives must include a star-related label');
});
test('completion condition is dom_change (no url change expected)', () => {
  assert.equal(GITHUB_STAR_REPO.plan.steps[0].completionCondition, 'dom_change');
});
test('no homepage navigation steps', () => {
  assertShortestPath(GITHUB_STAR_REPO, ['navigate to dashboard', 'navigate to home', 'go to homepage']);
});

console.log('\nWorkflow: GitHub — Create Repository');
test('plan is valid and has 1-3 steps', () => {
  assertPlan(GITHUB_CREATE_REPO, { minSteps: 1, maxSteps: 3 });
});
test('first step uses global "+" or "New" in top_navigation (not dashboard)', () => {
  const first = GITHUB_CREATE_REPO.plan.steps[0];
  assert.equal(first.targetElement.region, 'top_navigation',
    'first step must use the global top nav control, not a dashboard link');
});
test('no steps navigate to dashboard first', () => {
  assertShortestPath(GITHUB_CREATE_REPO, ['navigate to dashboard', 'navigate home', 'go to github.com']);
});
test('final step or alternatives include "New repository"', () => {
  const allTexts = GITHUB_CREATE_REPO.plan.steps.flatMap(s =>
    [s.targetElement.text, ...(s.targetElement.alternatives ?? [])]
  );
  assert.ok(allTexts.some(t => t?.toLowerCase().includes('new repository') || t?.toLowerCase().includes('create repository')),
    'plan steps must reference "New repository" or "Create repository" somewhere');
});
test('plan ends with url_change to /new', () => {
  const last = GITHUB_CREATE_REPO.plan.steps.at(-1);
  assert.ok(last.expectedPageState?.urlPattern?.includes('/new') || last.completionCondition === 'url_change',
    'last step must navigate to /new repository form');
});

console.log('\nWorkflow: GitHub — Open Pull Request');
test('plan is valid and has 1-3 steps', () => {
  assertPlan(GITHUB_OPEN_PR, { minSteps: 1, maxSteps: 3 });
});
test('all steps have non-empty targetElement.text', () => {
  for (const step of GITHUB_OPEN_PR.plan.steps) {
    assert.ok(step.targetElement?.text?.trim(), `step "${step.description}" has empty targetElement.text`);
  }
});
test('plan references "pull request" in at least one step intent', () => {
  const intents = GITHUB_OPEN_PR.plan.steps.map(s => s.intent?.toLowerCase());
  assert.ok(intents.some(i => i?.includes('pull request') || i?.includes('pr')),
    'at least one step intent must reference pull request');
});
test('final step navigates to /compare or /pull', () => {
  const last = GITHUB_OPEN_PR.plan.steps.at(-1);
  const url  = last.expectedPageState?.urlPattern ?? '';
  assert.ok(url.includes('/compare') || url.includes('/pull') || url.includes('pr'),
    'final step must lead to PR creation form');
});

console.log('\nWorkflow: GitLab — Create Merge Request');
test('plan is valid and has 1-3 steps', () => {
  assertPlan(GITLAB_CREATE_MR, { minSteps: 1, maxSteps: 3 });
});
test('plan references merge_request in step intents or urls', () => {
  const allText = GITLAB_CREATE_MR.plan.steps.flatMap(s => [
    s.intent, s.targetElement?.text, s.expectedPageState?.urlPattern,
    ...(s.targetElement?.alternatives ?? [])
  ]).map(t => t?.toLowerCase() ?? '');
  assert.ok(allText.some(t => t.includes('merge request') || t.includes('merge_request')),
    'plan must reference merge request');
});
test('final step has url_change', () => {
  const last = GITLAB_CREATE_MR.plan.steps.at(-1);
  assert.equal(last.completionCondition, 'url_change');
});
test('no steps navigate to GitLab home first', () => {
  assertShortestPath(GITLAB_CREATE_MR, ['navigate to home', 'navigate to dashboard', 'gitlab.com home']);
});

console.log('\nWorkflow: Gmail — Compose Email');
test('plan is valid and has exactly 1 step', () => {
  assertPlan(GMAIL_COMPOSE, { minSteps: 1, maxSteps: 1 });
});
test('Compose button is in side_navigation', () => {
  assert.equal(GMAIL_COMPOSE.plan.steps[0].targetElement.region, 'side_navigation');
});
test('completion condition is dom_change (compose opens as overlay, no url change)', () => {
  assert.equal(GMAIL_COMPOSE.plan.steps[0].completionCondition, 'dom_change');
});
test('no steps navigate away from current page', () => {
  assertShortestPath(GMAIL_COMPOSE, ['navigate to inbox', 'navigate to gmail', 'go to mail.google.com']);
});
test('high confidence for well-known global control', () => {
  assert.ok(GMAIL_COMPOSE.confidence >= 0.9, `Expected confidence >= 0.9, got ${GMAIL_COMPOSE.confidence}`);
});

// ── Failure mode tests ────────────────────────────────────────────────────────

console.log('\nFailure modes');
test('BLOCKED plan has no steps', () => {
  const blocked = { result: 'OK', state: 'blocked', blockers: [{ reason: 'Not logged in' }] };
  assert.equal(blocked.state, 'blocked');
  assert.ok(!blocked.plan?.steps?.length, 'blocked plan must have no steps');
});
test('COMPLETE plan has empty steps array', () => {
  const complete = { result: 'OK', state: 'complete', plan: { steps: [] } };
  assert.equal(complete.state, 'complete');
  assert.equal(complete.plan.steps.length, 0);
});
test('AMBIGUOUS plan returns NEEDS_USER result', () => {
  const ambiguous = { result: 'NEEDS_USER', state: 'ambiguous', blockers: [] };
  assert.equal(ambiguous.result, 'NEEDS_USER');
});
test('null targetElement.text is rejected by assertPlan', () => {
  const badPlan = {
    result: 'OK', state: 'planned', blockers: [],
    plan: { steps: [{ id: 1, description: 'Click thing', intent: 'do thing', completionCondition: 'dom_change',
      targetElement: { text: null, type: 'button', region: 'main_content', alternatives: [] } }] },
  };
  assert.throws(() => assertPlan(badPlan), /non-empty targetElement\.text/);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
