# 20. Phase-Wise Implementation Plan

**Timeline**: 1 Day (Hackathon Sprint)

---

## Phase 1: Foundation (Hours 1-3)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Phase 1: Foundation                         │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │                                                         │      │
│  │  1.1 Chrome Extension Setup                            │      │
│  │      - Create manifest.json                            │      │
│  │      - Set up background.js                          │      │
│  │      - Set up content.js                             │      │
│  │      - Test injection                               │      │
│  │                                                         │      │
│  │  1.2 Widget UI Implementation                      │      │
│  │      - Create floating widget HTML/CSS             │      │
│  │      - Implement show/hide toggle                 │      │
│  │      - Add input field and button                   │      │
│  │                                                         │      │
│  │  1.3 Basic Message Passing                       │      │
│  │      - Content → Background messaging            │      │
│  │      - Background → Content messaging          │      │
│  │      - Test round-trip                          │      │
│  │                                                         │      │
│  └─────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

**Deliverable**: Extension loads, widget appears on icon click, basic messaging works.

**Time**: 3 hours

---

## Phase 2: AI Integration (Hours 3-5)

```
┌─────────────────────────────────────────────────────────────────┐
│                 Phase 2: AI Integration                        │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │                                                         │      │
│  │  2.1 Gemini API Setup                               │      │
│  │      - Get API key                                 │      │
│  │      - Create API client in background.js          │      │
│  │      - Test basic API call                         │      │
│  │                                                         │      │
│  │  2.2 Prompt Engineering                         │      │
│  │      - Create prompt template                   │      │
│  │      - Handle response parsing                  │      │
│  │                                                         │      │
│  │  2.3 Error Handling                            │      │
│  │      - Timeout handling                        │      │
│  │      - API error handling                     │      │
│  │      - Retry logic                           │      │
│  │                                                         │      │
│  └─────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

**Deliverable**: User input sent to Gemini, action plan received and logged.

**Time**: 2 hours

---

## Phase 3: DOM Navigation (Hours 5-8)

```
┌─────────────────────────────────────────────────────────────────┐
│                 Phase 3: DOM Navigation                       │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │                                                         │      │
│  │  3.1 DOMLocator Implementation                        │      │
│  │      - Implement find by text                        │      │
│  │      - Implement find by aria-label                  │      │
│  │      - Implement find by data-testid                 │      │
│  │      - Implement fallback chain                      │      │
│  │                                                         │      │
│  │  3.2 Highlighter Implementation                     │      │
│  │      - Create overlay element                        │      │
│  │      - Position overlay on target                  │      │
│  │      - Add pulse animation                        │      │
│  │      - Implement clear                           │      │
│  │                                                         │      │
│  │  3.3 Integration                                  │      │
│  │      - Connect AI response to DOMLocator            │      │
│  │      - Connect DOMLocator to Highlighter           │      │
│  │      - Test on Gmail, GitHub                     │      │
│  │                                                         │      │
│  └─────────────────────────────────────────────────────────┘      │
```

**Deliverable**: AI action → element found → element highlighted.

**Time**: 3 hours

---

## Phase 4: Workflow Loop (Hours 8-11)

```
┌─────────────────────────────────────────────────────────────────┐
│                  Phase 4: Workflow Loop                       │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │                                                         │      │
│  │  4.1 PageObserver Implementation                     │      │
│  │      - Implement MutationObserver                  │      │
│  │      - Detect URL changes                          │      │
│  │      - Debounce and filter                       │      │
│  │                                                         │      │
│  │  4.2 Workflow State Management                   │      │
│  │      - Track current step                       │      │
│  │      - Store step history                       │      │
│  │      - Handle completion                       │      │
│  │                                                         │      │
│  │  4.3 Re-analysis Loop                         │      │
│  │      - After page change, re-send to AI         │      │
│  │      - Get next action                         │      │
│  │      - Continue until complete                │      │
│  │                                                         │      │
│  │  4.4 End-to-End Testing                        │      │
│  │      - Test complete workflow on GitHub        │      │
│  │      - Test complete workflow on Gmail         │      │
│  │      - Test error recovery                      │      │
│  │                                                         │      │
│  └─────────────────────────────────────────────────────────┘      │
```

**Deliverable**: Complete workflow loop works end-to-end.

**Time**: 3 hours

---

## Phase 5: Polish (Hours 11-12)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Phase 5: Polish                           │
│  ┌─────────────────────────────────────────────────────────┐      │
│  │                                                         │      │
│  │  5.1 Error Recovery                                   │      │
│  │      - Element not found handling                    │      │
│  │      - Page change detection failures                 │      │
│  │      - API failure handling                          │      │
│  │                                                         │      │
│  │  5.2 User Experience                              │      │
│  │      - Loading states                               │      │
│  │      - Success messages                           │      │
│  │      - Error messages                            │      │
│  │      - Widget minimize on complete               │      │
│  │                                                         │      │
│  │  5.3 Final Testing                          │      │
│  │      - Demo dry run                          │      │
│  │      - Bug fixes                             │      │
│  │                                                         │      │
│  └─────────────────────────────────────────────────────────┘      │
```

**Deliverable**: Production-ready extension for demo.

**Time**: 1 hour

---

## Single Day Timeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    12-Hour Implementation Schedule                │
├─────────────────────────────────────────────────────────────────┤
│                                                         │
│  Hour 1-3   │ Phase 1: Foundation                        │
│  ───────────┼──────────────────────────────────��─��──────   │
│  Hour 3-5   │ Phase 2: AI Integration                    │
│  ───────────┼───────────────────────────────────────────   │
│  Hour 5-8   │ Phase 3: DOM Navigation                   │
│  ───────────┼───────────────────────────────────────────   │
│  Hour 8-11  │ Phase 4: Workflow Loop                    │
│  ───────────┼───────────────────────────────────────────   │
│  Hour 11-12 │ Phase 5: Polish & Demo Prep              │
│                                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Parallel Tasks (Run Concurrently)

| Task | Owner | Dependencies |
|------|------|-------------|
| Manifest + background.js | Dev 1 | None |
| Widget UI | Dev 2 | None |
| Gemini API client | Dev 3 | API key ready |
| DOMLocator | Dev 1 | Phase 1 complete |
| Highlighter | Dev 2 | None |
| PageObserver | Dev 3 | Phase 1 complete |
| Integration | Dev 1+2 | All components |
| Testing | All | Integration complete |

---

## Critical Path (Must Complete in Order)

```
1. manifest.json + content.js injection
         ↓
2. Widget UI renders
         ↓
3. Gemini API responds
         ↓
4. DOMLocator finds element
         ↓
5. Highlighter shows overlay
         ↓
6. PageObserver detects change
         ↓
7. Re-analysis loop works
         ↓
8. End-to-end demo ready
```

---

## Hourly Checkpoints

| Time | Checkpoint | Success Criteria |
|------|------------|------------------|
| Hour 1 | Extension loads | Icon appears, no errors |
| Hour 3 | Widget works | Input field accepts text |
| Hour 5 | AI responds | Gemini returns action |
| Hour 8 | Element highlights | Glow shows on target |
| Hour 11 | Full loop works | Goal completes |
| Hour 12 | Demo ready | 3-min demo runs |

---

## If Running Out of Time: Fallback Priority

1. **Must have**: Widget + Gemini + highlight (basic demo works)
2. **Should have**: DOMLocator + PageObserver (full loop)
3. **Nice to have**: Error handling + polish