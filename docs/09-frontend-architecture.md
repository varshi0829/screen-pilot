# 9. Frontend Architecture

## 9.1 Widget UI Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              ScreenPilot Widget (Fixed Position)             │  │
│  │                                                         │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  📍 ScreenPilot                    [_] [−] [×]   │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                         │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  Current: github.com/user/repo                      │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                         │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │                                                 │  │  │
│  │  │  What do you want to do?                        │  │  │
│  │  │  ┌─────────────────────────────────────────────┐   │  │  │
│  │  │  │ Create a new issue about the            │   │  │  │
│  │  │  │ login bug we found                      │   │  │  │
│  │  │  └─────────────────────────────────────────────┘   │  │  │
│  │  │                                                 │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                         │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  [Cancel]                        [Go →]              │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                                                         │  │
│  │  Status: Analyzing...                                  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└────────────────────────────────���────────────────────────────────┘
```

## 9.2 Widget States

| State | UI Display | Behavior |
|-------|------------|----------|
| `IDLE` | Input field ready, Go button enabled | Waiting for user input |
| `ANALYZING` | "Analyzing..." spinner | Sending to AI, disabled input |
| `HIGHLIGHTING` | "Click the highlighted element" | Waiting for user click |
| `EXECUTING` | "Executing..." | Auto-click mode (if enabled) |
| `OBSERVING` | "Checking page..." | Waiting for page change |
| `COMPLETE` | "Done! ✓" green | Success message, auto-hide |
| `ERROR` | Error message red | Retry button shown |

## 9.3 Widget Positioning

- **Position**: Fixed, bottom-right corner
- **Default size**: 320px wide, auto height
- **Collapsed size**: 48px × 48px (icon only)
- **Z-index**: 999999 (above most page content)
- **Draggable**: Yes, within viewport bounds