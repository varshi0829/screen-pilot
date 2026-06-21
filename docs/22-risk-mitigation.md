# 22. Risk Mitigation Strategies

## 22.1 Element Not Found

```
┌─────────────────────────────────────────────────────────────────┐
│              Mitigation: Element Not Found                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                                                         │    │
│  │  Strategy: Cascading fallback                            │    │
│  │                                                         │    │
│  │  1. Try exact text match                             │    │
│  │  2. Try contains text match                        │    │
│  │  3. Try fuzzy text match                            │    │
│  │  4. Try position-based (last resort)               │    │
│  │                                                         │    │
│  │  If all fail:                                        │    │
│  │  - Send "NOT_FOUND" to Gemini                        │    │
│  │  - Ask for alternative element description        │    │
│  │  - Or ask user to click the element manually       │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
```

## 22.2 Page Change Detection

```
┌─────────────────────────────────────────────────────────────────┐
│           Mitigation: Page Change Detection                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                                                         │    │
│  │  Strategy: Multi-signal detection                       │    │
│  │                                                         │    │
│  │  1. MutationObserver (primary)                       │    │
│  │  2. URL change detection (secondary)                 │    │
│  │  3. Network idle (tertiary)                          │    │
│  │  4. Timeout fallback (2 seconds)                   │    │
│  │                                                         │    │
│  │  If no change detected after timeout:               │    │
│  │  - Assume action may have failed                     │    │
│  │  - Re-analyze current page                          │    │
│  │  - Ask user to confirm page state                   │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
```

## 22.3 Cross-Origin Iframes

```
┌─────────────────────────────────────────────────────────────────┐
│           Mitigation: Cross-Origin Iframes                     │
│  ┌──────────────────────���──────────────────────────────────┐    │
│  │                                                         │    │
│  │  Strategy: Detection and warning                        │    │
│  │                                                         │    │
│  │  1. Detect if target is in iframe                      │    │
│  │  2. Check if iframe is same-origin                    │    │
│  │  3. If cross-origin:                                 │    │
│  │     - Cannot access iframe DOM                       │    │
│  │     - Show warning to user                           │    │
│  │     - Ask user to click manually                     │    │
│  │                                                         │    │
│  │  Note: This is a known limitation for MVP             │    │
│  │                                                         │    │
│  └─────────────────────────────────────────────────────────┘    │
```