# 12. Highlighting Engine

## 12.1 Highlighting Mechanism

The Highlighter component renders a visual overlay on the target element:

```
┌─────────────────────────────────────────────────────────────────┐
│                   Highlighting Approach                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │  Before:         After:                         │  │
│  │  ┌───────┐      ┌───────┐                      │  │
│  │  │Button│      │Button│  ← with glow effect   │  │
│  │  └───────┘      └───────┘                      │  │
│  │                                                 │  │
│  │  Implementation:                              │  │
│  │  1. Get element.getBoundingClientRect()     │  │
│  │  2. Create overlay div                   │  │
│  │  3. Position: fixed                    │  │
│  │  4. Apply box-shadow with animation    │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 12.2 Overlay Implementation

```javascript
// Pseudocode - not implementation
function highlight(element) {
  // Get element position
  const rect = element.getBoundingClientRect();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'screenpilot-highlight';
  overlay.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    border: 2px solid #4F46E5;
    border-radius: 4px;
    box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.3);
    animation: pulse 1.5s ease-in-out infinite;
    pointer-events: none;
    z-index: 999998;
  `;

  document.body.appendChild(overlay);
}
```

## 12.3 Animation Styles

```css
/* Pulse animation for MVP */
@keyframes screenpilot-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(79, 70, 229, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(79, 70, 229, 0);
  }
}
```

## 12.4 Design Decisions

| Decision | Rationale |
|---------|-----------|
| Fixed positioning | Works with scrolling, doesn't require element modification |
| Box-shadow glow | Non-destructive, doesn't alter page layout |
| pointer-events: none | Allows click-through to underlying element |
| Animation | Draws attention without being distracting |
| Z-index 999998 | Below widget, above most page content |