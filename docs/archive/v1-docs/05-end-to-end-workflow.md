# 5. End-to-End Workflow

## 5.1 The Complete Workflow

### Phase 1: Initialization
- User clicks extension icon
- Extension injects content script
- Floating widget renders in DOM
- Widget listens for input

### Phase 2: Goal Capture
- User types goal: "Create GitHub issue"
- Widget captures current page URL
- Widget captures DOM snapshot (optional)
- Sends to background script

### Phase 3: AI Analysis
- Background script forwards to Gemini
- Gemini analyzes: URL → identifies application, Goal → decomposes into steps, DOM → identifies target elements
- Returns action plan: `{targetText: "Issues", instruction: "Click Issues tab"}`

### Phase 4: Element Identification
- Content script receives action
- Queries DOM for element: Find link/button with text "Issues", Or find element with matching aria-label, Or find element with matching data-testid
- If found → highlight element
- If not found → request re-analysis

### Phase 5: User Action
- Element highlighted with glow
- User clicks highlighted element
- Page navigates/changes
- Content script detects change
- Reports new state to AI

### Phase 6: Loop
- AI receives new state
- Determines next action
- Returns next target
- Go to Phase 4

### Phase 7: Completion
- AI determines goal complete
- Returns completion message
- Widget shows success
- Widget minimizes

## 5.2 Workflow State Machine

```
┌─────────────┐
│   IDLE      │◀────────────────────────────┐
└──────┬──────┘                             │
       │ user activates                        │
       ▼                                    │
┌─────────────┐     ┌─────────────────────────┤
│  WAITING    │────▶│    ANALYZING          │
│ (input)     │     │  (Gemini processing)   │
└──────┬──────┘     └───────────┬─────────┘
       │                        │
       │ goal received          │ action plan
       ▼                        ▼
┌─────────────┐     ┌─────────────────────────┐
│  LOCATING   │────▶│   HIGHLIGHTING          │
│ (DOM find)  │     │  (visual feedback)     │
└──────┬──────┘     └───────────┬─────────┘
       │                        │
       │ element found         │ user clicks
       ▼                        ▼
┌─────────────┐     ┌─────────────────────────┐
│  COMPLETE   │◀────│    OBSERVING            │
│ (success)   │     │  (page change)         │
└─────────────┘     └─────────────────────────┘
```