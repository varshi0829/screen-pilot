# 8. Chrome Extension Architecture

## 8.1 Manifest V3 Structure

```
screenpilot/
├── manifest.json          # Extension manifest
├── background.js         # Service worker (background)
├── content.js          # Content script (injected)
├── popup/
│   └── popup.html     # Optional popup (not used in MVP)
├── styles/
│   └── widget.css    # Widget styles
├── lib/
│   ├── dom-locator.js    # Element finding
│   ├── highlighter.js   # Visual overlay
│   ├── page-observer.js # Change detection
│   └── state-manager.js # State persistence
├── services/
│   ├── goal-manager.js   # Goal tracking
│   └── action-planner.js # AI integration
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 8.2 Content Script Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Content Script                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Initialization                        │  │
│  │  - Check if already injected                              │  │
│  │  - Inject styles                                          │  │
│  │  - Create widget container                               │  │
│  │  - Initialize components                                  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Widget Layer                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │   Input     │  │   Status    │  │    Actions     │   │  │
│  │  │   Field     │  │   Display   │  │   (Cancel/OK)  │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Navigation Layer                      │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │  DOMLocator │  │ Highlighter │  │  PageObserver   │   │  │
│  ���  │             │  │             │  │                 │   │  │
│  │  │ - find()    │  │ - highlight()│ │ - observe()    │   │  │
│  │  │ - findAll() │  │ - clear()   │  │ - onChange()   │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Communication                         │  │
│  │  - chrome.runtime.sendMessage() → Background           │  │
│  │  - chrome.runtime.onMessage() ← Background             │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 8.3 Background Script Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Background Service Worker                   │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Message Router                        │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │  FROM_CONTENT: analyze → Gemini → TO_CONTENT    │    │  │
│  │  │  FROM_CONTENT: getState → TO_STORAGE           │    │  │
│  │  │  FROM_POPUP: getTab → TO_TAB                    │    │  │
│  │  └─────────────────────────────────────────────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    API Integration                       │  │
│  │  ┌─────────────────────────────────────────────────┐    │  │
│  │  │              Gemini API Client                  │    │  │
│  │  │                                               │    │  │
│  │  │  - analyzeGoal(page, goal)                     │    │  │
│  │  │  - planAction(state, goal)                    │    │  │
│  │  │  - validateCompletion(state, goal)            │    │  │
│  │  └──────────────────────────────────────���──────────┘    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                              │                                │
│                              ▼                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Storage                               │  │
│  │  - chrome.storage.local for state                      │  │
│  │  - chrome.storage.session for temporary state           │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 8.4 Message Protocol

| Message | Direction | Payload | Response |
|---------|-----------|---------|----------|
| `ANALYZE_GOAL` | Content → Background | `{url, goal, dom}` | `{action, target}` |
| `ELEMENT_NOT_FOUND` | Content → Background | `{criteria}` | `{retry, fallback}` |
| `ACTION_COMPLETE` | Content → Background | `{elementId}` | `{nextAction, complete}` |
| `PAGE_CHANGED` | Content → Background | `{newUrl, newDom}` | `{continue, abort}` |
| `HIGHLIGHT` | Background → Content | `{element}` | `{success}` |
| `CLEAR_HIGHLIGHT` | Background → Content | `{}` | `{success}` |