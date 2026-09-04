# 10. AI Orchestration Layer

## 10.1 Gemini Integration

The ActionPlanner component interfaces with Gemini API. The integration follows this pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Gemini API Call Flow                        │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  1. Prepare prompt with:                                │  │
│  │     - Current page URL                                   │  │
│  │     - Current page title                                │  │
│  │     - User goal                                         │  │
│  │     - Available DOM elements (optional)                 │  │
│  │                                                         │  │
│  │  2. Send to Gemini 2.0 Flash                            │  │
│  │                                                         │  │
│  │  3. Parse response:                                    │  │
│  │     {                                                   │  │
│  │       "targetText": "Issues",  // What to find         │  │
│  │       "instruction": "Click Issues tab", // What to do │  │
│  │       "nextStep": "Fill in issue details"              │  │
│  │       "complete": false                                 │  │
│  │     }                                                   │  │
│  │                                                         │  │
│  │  4. Return to Content Script                            │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 10.2 Prompt Engineering

For the MVP, use a structured prompt template:

```
You are ScreenPilot, an AI assistant that helps users navigate web applications.

Current Page: {url}
Page Title: {title}
User Goal: {goal}

Analyze the current page and determine the next action to achieve the user's goal.

Respond with a JSON object:
{
  "targetText": "The text or label of the element to interact with",
  "instruction": "A brief description of the action",
  "nextStep": "What comes after this action",
  "complete": true/false
}

If the goal is complete, set complete to true.
If you cannot find a suitable element, set targetText to "NOT_FOUND" and explain why.
```

## 10.3 Response Handling

| Response Field | Handling |
|----------------|----------|
| `targetText` | Pass to DOMLocator for element finding |
| `instruction` | Display to user in widget status |
| `nextStep` | Store for next iteration |
| `complete` | If true, show success and end workflow |

## 10.4 Error Handling

| Error | Handling |
|-------|----------|
| API timeout | Retry once, then show error |
| API error | Show error with retry button |
| Invalid JSON | Retry with simplified prompt |
| Rate limit | Queue request, show "waiting" status |