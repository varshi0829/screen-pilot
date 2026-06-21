# 16. Data Flow Diagram

## 16.1 Complete Data Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  User   │────▶│  Widget    │────▶│  Background │────▶│  Gemini    │
│ Input   │     │  (Input)   │     │  (API)      │     │  (AI)       │
└─────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                                                         │
                                                         ▼
┌─────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  User   │◀────│  Widget    │◀────│  Content   │◀────│  DOM       │
│ Click   │     │  (Status)  │     │  (Action)  │     │  Locator   │
└─────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                    │                    │                    │
       │                    │                    │                    ▼
       │                    │                    │            ┌─────────────┐
       │                    │                    │            │  Highlighter │
       │                    │                    │            │  (Visual)  │
       │                    │                    │            └─────────────┘
       │                    │                    │
       │                    │                    ▼
       │                    │            ┌─────────────┐
       │                    │            │  Page       │
       └───────────────────▶│  Observer  │◀──── (Change)
                          │  (Detect) │
                          └─────────────┘
```

## 16.2 Message Flow Sequence

```
User: "Create GitHub issue"
         │
         ▼
Widget: sendMessage({type: "ANALYZE_GOAL", goal: "..."})
         │
         ▼
Background: chrome.storage.session.set(state)
         │
         ▼
Background: fetch(Gemini API)
         │
         ▼
Background: sendMessage({type: "ACTION", target: "Issues"})
         │
         ▼
Content: DOMLocator.find("Issues")
         │
         ▼
Content: Highlighter.highlight(element)
         │
         ▼
Widget: setStatus("Click Issues tab")
         │
         ▼
User: clicks element
         │
         ▼
PageObserver: detects change
         │
         ▼
Content: sendMessage({type: "PAGE_CHANGED"})
         │
         ▼
Background: fetch(Gemini API, next step)
         │
         ▼
[Loop until complete]
```