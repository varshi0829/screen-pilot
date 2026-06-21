# ScreenPilot

AI-powered navigation assistant for web applications. Acts as GPS for software by providing step-by-step visual guidance directly inside any webpage.

## Status: MVP Complete ✅

The first working end-to-end workflow is implemented and ready for testing.

## What Works

- ✅ Floating widget UI injected into any webpage
- ✅ Goal input and workflow initiation
- ✅ Screenshot capture of visible page
- ✅ Gemini Vision API integration for page understanding
- ✅ Intelligent DOM element matching (exact, fuzzy, synonym)
- ✅ Visual highlight overlay with instructions
- ✅ Automatic page change detection
- ✅ Multi-step workflow loop
- ✅ State persistence across page transitions
- ✅ Confidence scoring and user confirmation
- ✅ Progress tracking and history

## Quick Start

### 1. Install Extension

```bash
# Load in Chrome
chrome://extensions/
→ Enable "Developer mode"
→ Click "Load unpacked"
→ Select this directory
```

### 2. Configure API Key

- Click ScreenPilot extension icon
- Get free API key: https://aistudio.google.com/app/apikey
- Paste and save

### 3. Test on Gmail

```
1. Open https://mail.google.com
2. Click extension → "Open ScreenPilot"
3. Enter goal: "Schedule an email"
4. Click "Go →"
5. Follow highlighted elements
```

## Architecture

```
User Input (Goal)
    ↓
Content Script (Widget + Observer)
    ↓
Background Worker (Orchestrator)
    ↓
Screenshot Service → Gemini Vision API
    ↓
State Manager (Workflow Tracking)
    ↓
DOM Matcher (Element Locator)
    ↓
Highlight Renderer (Visual Overlay)
    ↓
Page Change Detection → Loop
```

## Components

### Content Script (`content.js`)
- Renders floating widget
- Highlights target elements
- Detects page changes (MutationObserver)
- Manages UI state

### Background Service (`background.js`)
- Orchestrates workflow
- Manages screenshot capture
- Calls Gemini API
- Persists state across pages

### DOM Matcher (`lib/dom-matcher.js`)
- Finds elements from AI descriptions
- Supports exact, fuzzy, synonym matching
- Handles ARIA labels and accessibility

### Services
- `screenshot-service.js` - Captures visible tab
- `vision-service.js` - Gemini Vision integration
- `state-manager.js` - Workflow state persistence

### Popup
- API key configuration
- Widget activation

## Test Results

Latest automated test run: **100% success rate**

- Total workflows: 10
- Total steps: 12
- Successful: 12/12
- Average confidence: 0.89
- Match types: 92% exact, 8% synonym

## Files

```
screen-pilot/
├── manifest.json          # Extension configuration
├── content.js             # Main content script (19KB)
├── background.js          # Service worker
├── lib/
│   └── dom-matcher.js     # Element matching engine
├── services/
│   ├── screenshot-service.js
│   ├── vision-service.js
│   └── state-manager.js
├── popup/
│   ├── popup.html
│   └── popup.js
├── styles/
│   └── widget.css
├── tests/
│   ├── workflow-fixtures.js
│   └── run-workflow-tests.js
├── test-results/
│   └── workflow-report.md
└── docs/                  # 26 architecture documents
```

## Dependencies

- `jsdom` ^24.1.0 (dev/testing only)
- Chrome Extensions API (Manifest V3)
- Gemini 2.0 Flash API

## Next Steps

1. ✅ **Validate Gmail workflow** (current objective)
2. Test on additional websites
3. Measure success rates across patterns
4. Refine prompts for accuracy
5. Add error recovery
6. Handle edge cases (modals, SPAs, dynamic content)

## Documentation

See `/docs` for comprehensive architecture documentation:
- Executive summary
- Technical architecture
- System components
- Implementation plans
- Risk analysis

## Testing

```bash
# Run automated tests
npm run test:workflows

# Manual testing
See TESTING.md for step-by-step guide
```

## Debug Mode

Enable detailed logging:
```javascript
// In content.js and background.js
const DEBUG = true;
```

## License

Internal project - Architecture validation phase
