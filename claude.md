# ScreenPilot — Permanent Development Rules

## Core principle

ScreenPilot must be a GENERIC browser agent.

It must work across arbitrary websites and natural-language user goals without website-specific programming.

## NEVER hardcode

Do NOT introduce:

- website-specific rules
- website-specific selectors
- hardcoded commands
- hardcoded user phrases
- hardcoded synonyms
- phrase-specific if/else logic
- special cases for Wikipedia, GitHub, YouTube, etc.
- manually defined navigation routes for individual websites

Examples in prompts/tests are demonstrations of desired semantic behavior only.
They must NOT become implementation rules.

## Smart task execution

ScreenPilot should:

- understand natural-language goals semantically
- identify the user's actual intended action
- identify the correct UI target
- distinguish UI labels/descriptions from user-provided values
- extract user-provided payloads correctly
- prefer the shortest valid path to the goal
- avoid unnecessary clicks/navigation
- avoid exploratory actions when the target is already available
- avoid unnecessary model calls
- avoid unnecessary replanning
- replan only when verification shows the previous action failed or the page changed

Correctness AND execution efficiency matter.

## Current architecture

Goal
↓
PageStateService
↓
L1 deterministic exact grounding
↓
L2 generic grounding
↓
Qwen semantic planning
↓
Executor
↓
Verify
↓
Replan only when necessary

Moondream is visual perception, not the primary semantic planner.

Do not add another model/layer unless investigation demonstrates that the current architecture cannot solve the problem generically.

Adding complexity is NOT the default solution.

## Planner principle

The planner must conceptually distinguish:

1. What does the user want to DO?
2. Which UI element performs that action?
3. What VALUE did the user actually provide?

For example:

"Search Wikipedia for artificial intelligence"

must semantically become:

action = search/fill
target = appropriate search input
value = "artificial intelligence"

The string "Search Wikipedia" is NOT the value.

UI labels, placeholders, aria-labels, titles, etc. describe UI elements.
They must not automatically become user-entered text.

This behavior must generalize to arbitrary websites and phrasing.

## Current known failure

On Wikipedia:

Goal:
"Search Wikipedia for artificial intelligence"

Observed:
- ScreenPilot selected "English"
- then entered "Search Wikipedia" into the search box
- execution took unnecessarily long

This is a diagnostic example, NOT a case to hardcode.

Investigate whether the root cause is:
- planner prompt/schema
- L2 grounding
- page-state representation
- action representation
- planner/executor contract
- verification/replanning
- or a combination

Fix the underlying generic problem.

## Architecture discipline

Before changing architecture:

1. Inspect the existing implementation.
2. Identify the actual root cause.
3. Prefer the smallest change that solves the generic problem.
4. Do not modify unrelated working components.
5. Do not add another model merely because one example failed.
6. Measure whether a change improves both correctness and efficiency.

## Testing

Every fix must include generic regression tests.

Tests should use multiple:
- natural-language phrasings
- websites/pages
- target types
- user-provided values

Tests must verify:
- correct semantic target
- correct user payload
- irrelevant UI elements are not selected
- unnecessary navigation is avoided
- existing behavior does not regress
- no website-specific logic was introduced

Never weaken/delete existing tests simply to make them pass.

## Performance

Track:
- model calls per task
- planning cycles
- unnecessary actions
- end-to-end latency
- local model latency
- vision invocation frequency

A solution that is more accurate but unnecessarily much slower is not automatically an improvement.

## Privacy

Do not destabilize the existing privacy architecture unless a concrete privacy flaw is demonstrated.

Sensitive content must be sanitized before network requests.

## Development workflow

Before implementation:
- diagnose
- explain root cause
- propose minimal fix

After implementation:
- run the full test suite
- report files changed
- report tests added
- report final test count
- report latency/model-call impact
- report any regressions
- explain why the solution generalizes

## Final documentation

After implementation/testing is complete, update/create:

docs/SCREENPILOT_INTERVIEW_GUIDE.md

It must describe the FINAL implementation only, including:
- problem statement
- final architecture
- component responsibilities
- architecture decisions and rationale
- privacy architecture and limitations
- generic NLU/planning
- L1/L2/Qwen/Moondream routing
- timeout/cancellation/warm-up
- latency measurements
- all five evaluation metrics using only measured values
- tests and final counts
- important files/functions
- debugging history
- 30-second explanation
- 2-minute explanation
- likely technical interview questions and accurate answers
- limitations/tradeoffs