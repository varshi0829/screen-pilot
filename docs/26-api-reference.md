# 26. Appendix: API Reference

## 26.1 Gemini API Request Format

```json
{
  "contents": [
    {
      "parts": [
        {
          "text": "You are ScreenPilot...\n\nCurrent Page: {url}\nPage Title: {title}\nUser Goal: {goal}\n\nAnalyze and respond with JSON..."
        }
      ]
    }
  ],
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 500,
    "topP": 0.95,
    "topK": 40
  }
}
```

## 26.2 Gemini API Response Format

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "{\"targetText\": \"Issues\", \"instruction\": \"Click Issues tab\", \"nextStep\": \"Click New issue button\", \"complete\": false}"
          }
        ]
      }
    }
  ]
}
```

## 26.3 Message Types

| Message | Direction | Payload |
|---------|-----------|---------|
| `ANALYZE_GOAL` | Content → Background | `{goal, url, title}` |
| `GET_ACTION` | Background → Gemini | `{state, goal}` |
| `ACTION_RESULT` | Gemini → Background | `{target, instruction, complete}` |
| `HIGHLIGHT_ELEMENT` | Background → Content | `{targetText}` |
| `PAGE_CHANGED` | Content → Background | `{url}` |
| `ERROR` | Any → Any | `{message, code}` |