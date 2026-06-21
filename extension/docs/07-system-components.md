# 7. System Components

## 7.1 Component List

| Component | Responsibility | Public API |
|-----------|----------------|-------------|
| **FloatingWidget** | User input capture, status display | `show()`, `hide()`, `setStatus()`, `getInput()` |
| **GoalManager** | Goal lifecycle, step tracking | `setGoal()`, `getCurrentStep()`, `complete()` |
| **ActionPlanner** | Gemini integration, action planning | `planAction(state)`, `analyzePage(dom)` |
| **DOMLocator** | Element finding using multiple strategies | `findElement(criteria)`, `findAll(criteria)` |
| **Highlighter** | Visual overlay rendering | `highlight(element)`, `clear()` |
| **PageObserver** | Navigation and mutation detection | `observe()`, `onNavigate(callback)` |
| **StateManager** | Workflow state persistence | `save()`, `load()`, `getState()` |
| **MessageRouter** | Content ↔ Background communication | `send()`, `onMessage()` |

## 7.2 Component Interactions

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Widget    │────▶│ GoalManager │────▶│ActionPlanner│
│  (Input)   │     │  (State)    │     │   (AI)      │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Highlighter│◀────│  DOMLocator │◀────│   Action    │
│  (Visual)   │     │  (Find)     │     │  (Target)   │
└──────────────┘     └──────────────┘     └──────────────┘
       │                    │                    │
       │                    │                    │
       ▼                    ▼                    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    User      │────▶│  PageObserver│────▶│  StateManager│
│   (Click)    │     │  (Detect)   │     │  (Persist)  │
└──────────────┘     └──────────────┘     └──────────────┘
```

## 7.3 Component Responsibilities

### FloatingWidget

**Why it exists**: The user needs a way to input their goal and see status updates without leaving the current page.

**Responsibility**: Renders an overlay on the current page, captures text input, displays status messages, shows completion state.

**Interactions**: Receives input → sends to GoalManager. Receives status → displays to user. Receives completion → shows success message.

**Design tradeoffs**: Using an iframe would isolate styles but complicate message passing. Using a DOM overlay is simpler but requires careful CSS scoping.

### GoalManager

**Why it exists**: The system needs to track what the user wants to achieve and decompose it into steps.

**Responsibility**: Stores the current goal, tracks progress through steps, determines when the goal is complete.

**Interactions**: Receives goal from Widget → stores. Sends state to ActionPlanner → receives action. Reports completion to Widget.

**Design tradeoffs**: Storing goal in memory is simpler but lost on page reload. Storing in chrome.storage requires async handling.

### ActionPlanner

**Why it exists**: The AI needs a dedicated component to interface with Gemini and transform user goals into actionable steps.

**Responsibility**: Sends page context to Gemini, receives action plans, handles retry logic on failure, validates responses.

**Interactions**: Sends DOM/URL to Gemini API ← receives action plan. Sends action to DOMLocator ← receives element. Reports completion to GoalManager.

**Design tradeoffs**: Calling Gemini on every action adds latency. Batching actions reduces API calls but reduces responsiveness. For MVP, call-per-action is acceptable.

### DOMLocator

**Why it exists**: The system needs to find UI elements based on semantic descriptions, not coordinates.

**Responsibility**: Implements multiple element-finding strategies (text, aria-label, data-testid, position), handles element not found errors, returns DOM references.

**Interactions**: Receives criteria from ActionPlanner → queries DOM. Returns element reference to Highlighter. Reports not found to ActionPlanner.

**Design tradeoffs**: Exact text matching is fast but brittle. Fuzzy matching is flexible but slower. Use exact first, fallback to fuzzy.

### Highlighter

**Why it exists**: The user needs visual guidance to know exactly where to click.

**Responsibility**: Renders a visual overlay on the target element, animates to draw attention, clears on action completion.

**Interactions**: Receives element from DOMLocator → renders overlay. Receives clear command → removes overlay.

**Design tradeoffs**: Using CSS box-shadow is performant but limited. Using SVG overlay is flexible but complex. For MVP, box-shadow + border is sufficient.

### PageObserver

**Why it exists**: The system needs to detect when the page changes after a user action to continue the workflow.

**Responsibility**: Monitors DOM mutations and navigation events, detects page transitions, reports new state to StateManager.

**Interactions**: Observes DOM → detects change. Reports new state to StateManager. Triggers re-analysis in ActionPlanner.

**Design tradeoffs**: MutationObserver is performant but requires careful filtering. Polling is reliable but resource-intensive. Use MutationObserver with debouncing.