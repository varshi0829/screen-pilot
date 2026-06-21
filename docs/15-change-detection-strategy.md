# 15. Change Detection Strategy

## 15.1 Page Change Detection

The PageObserver detects when the page changes after a user action:

```
┌─────────────────────────────────────────────────────────────────┐
│                   Change Detection Methods                     │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Method 1: MutationObserver                      │    │
│  │  - Watch for DOM additions/removals            │    │
│  │  - Debounce: 500ms                           │    │
│  │  - Filter: ignore analytics scripts           │    │
│  │                                                 │    │
│  │  Method 2: URL Change Detection               │    │
│  │  - Watch for history.pushState               │    │
│  │  - Watch for location.href changes          │    │
│  │                                                 │    │
│  │  Method 3: Network Idle                   │    │
│  │  - Wait for fetch/XHR completion          │    │
│  │  - Timeout: 2 seconds                  │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## 15.2 Implementation

```javascript
// Pseudocode - not implementation
class PageObserver {
  constructor(onChange) {
    this.onChange = onChange;
    this.debounceTimer = null;
  }

  observe() {
    // MutationObserver for DOM changes
    const observer = new MutationObserver(() => {
      this.debounce(() => this.onChange(), 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // History API interception
    const originalPushState = history.pushState;
    history.pushState = (...args) => {
      originalPushState.apply(history, args);
      this.onChange();
    };
  }

  debounce(fn, ms) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(fn, ms);
  }
}
```