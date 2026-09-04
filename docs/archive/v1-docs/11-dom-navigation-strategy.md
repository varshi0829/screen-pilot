# 11. DOM Navigation Strategy

## 11.1 The Coordinate Problem

Traditional vision-based approaches use screen coordinates:

```
┌─────────────────────────────────────────────────────────────────┐
│              Vision-Only Coordinate Detection                  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  Screenshot → Vision Model → {x: 0.42, y: 0.31}         │  │
│  │                                                         │  │
│  │  Problems:                                               │  │
│  │  - Coordinates drift on resize                           │  │
│  │  - Coordinates fail on scroll                           │  │
│  │  - Coordinates don't work on iframes                   │  │
│  │  - Different resolutions = different coordinates         │  │
│  │  - Dynamic content shifts positions                       │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 11.2 The DOM-Assisted Approach

ScreenPilot uses semantic element identification:

```
┌─────────────────────────────────────────────────────────────────┐
│              DOM-Assisted Navigation (Preferred)                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  Gemini → {targetText: "Compose"}                      │  │
│  │       ↓                                               │  │
│  │  DOMLocator → querySelector('[aria-label="Compose"]')  │  │
│  │       ↓                                               │  │
│  │  Found: <button aria-label="Compose">                  │  │
│  │       ↓                                               │  │
│  │  Highlighter → highlight(element)                      │  │
│  │                                                         │  │
│  │  Advantages:                                           │  │
│  │  - Works across resolutions                            │  │
│  │  - Works with scrolling                               │  │
│  │  - Works with iframes (with access)                   │  │
│  │  - Resilient to layout changes                        │  │
│  │  - Semantic, not positional                           │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────���────────────────────────────────────────────┘
```

## 11.3 Element Finding Strategies

The DOMLocator uses a cascade of strategies, from most specific to least:

| Priority | Strategy | Query Method | Example |
|----------|----------|--------------|----------|
| 1 | `data-testid` | `querySelector('[data-testid="..."]')` | `[data-testid="compose-btn"]` |
| 2 | `aria-label` | `querySelector('[aria-label="..."]')` | `[aria-label="Compose"]` |
| 3 | `aria-labelledby` | `getElementById(id).getAttribute('aria-labelledby')` | Links to label element |
| 4 | `text exact` | `querySelectorAll('button, a')` then filter | Text exactly matches |
| 5 | `text contains` | `querySelectorAll('button, a')` then filter | Text contains substring |
| 6 | `text fuzzy` | `querySelectorAll('button, a')` then fuzzy match | Levenshtein distance < 3 |
| 7 | `position` | `querySelectorAll('button, a')` then nth | Fallback: nth button |

## 11.4 Fallback Chain

```
findElement(targetText):
│
├── Try: data-testid exact match
│   └── Found → highlight → return
│
├── Try: aria-label exact match
│   └── Found → highlight → return
│
├── Try: text exact match (case-insensitive)
│   └── Found → highlight → return
│
├── Try: text contains (first match)
│   └── Found → highlight → return
│
├── Try: text fuzzy match (Levenshtein ≤ 3)
│   └── Found → highlight → return
│
└── NOT_FOUND → return error
```