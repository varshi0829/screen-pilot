# 4. User Experience Flow

## 4.1 Initial State

The user is on any website (Gmail, GitHub, Jira, etc.) performing their normal workflow. They encounter a task they don't know how to complete, or a task that requires multiple steps.

## 4.2 Activation

| User Action | System Response |
|-------------|----------------|
| Click extension icon | Floating widget appears in bottom-right corner |
| or keyboard shortcut (Alt+S) | |

## 4.3 Goal Statement

| User Input | System Response |
|------------|-----------------|
| "Schedule an email to team@company.com about Q3 review at 2pm tomorrow" | System captures current page context. Sends to AI for analysis. |

## 4.4 Navigation Loop

| AI Analysis | Visual Feedback |
|-------------|------------------|
| Analyzes page: Current page: Gmail, Goal: Compose email, Next action: Click "Compose" | Highlights "Compose" button with pulsing glow effect |
| User clicks "Compose" | Page changes to compose view |
| AI re-analyzes: Page changed to compose view, Next action: Fill "To" field | Highlights "To" field |
| User fills "To" field | AI re-analyzes: Next: Fill subject |

[Continues until goal complete]

## 4.5 Completion

| Goal Achieved | System Response |
|--------------|-----------------|
| Email sent successfully | Success message in widget. Widget minimizes after 3 seconds. |

## 4.6 ASCII Flow Diagram

```
┌─────────┐     ┌─────────────┐     ┌──────────┐
│  User   │────▶│   Widget    │────▶│   AI     │
│ on web  │     │   (Input)   │     │ (Gemini) │
└─────────┘     └─────────────┘     └──────────┘
                    │                    │
                    │                    │
                    ▼                    ▼
              ┌──────────┐        ┌──────────┐
              │  DOM     │◀───────│  Action  │
              │ Finder  │        │ Planner  │
              └──────────┘        └──────────┘
                    │                    │
                    │                    │
                    ▼                    ▼
              ┌──────────┐        ┌──────────┐
              │Highlight │        │  State   │
              │ Overlay  │        │ Manager  │
              └──────────┘        └──────────┘
                    │                    │
                    │                    │
                    ◀────────────────────┘
                         User Clicks
```