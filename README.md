# ScreenPilot

AI-powered navigation assistant for web applications. Acts as GPS for software by providing step-by-step visual guidance directly inside any webpage.

## Quick Start

### 1. Install Extension

```
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

1. Open https://mail.google.com
2. Click extension → "Open ScreenPilot"
3. Enter goal: "how do i compose a mail"
4. Click "Go"
5. Follow highlighted elements

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
UniversalPlanner + DOM Matcher
    ↓
Highlight Renderer (Visual Overlay)
    ↓
Page Change Detection → Re-analysis Loop
```

## Components

### Content Script (`content.js`)
- Floating widget UI
- UniversalPlanner for candidate ranking
- DOM matching with fuzzy/synonym support
- MutationObserver for page changes
- Input/focus/change event detection
- Highlighting engine with animations

### Background Service (`background.js`)
- Message handling (Manifest V3)
- Vision cycle orchestration
- Screenshot capture
- Gemini API calls
- State persistence

### DOM Matcher (`lib/dom-matcher.js`)
- Finds elements from AI descriptions
- Supports exact, fuzzy, synonym matching
- Handles ARIA labels and accessibility
- Levenshtein distance for fuzzy matching

### Services
- `vision-service.js` - Gemini 2.5 Flash Vision API
- `screenshot-service.js` - Visible tab capture
- `state-manager.js` - Workflow state persistence

### Popup
- API key configuration
- Widget activation

## Files

```
screen-pilot/
├── manifest.json              # Extension manifest (MV3)
├── content.js               # Main content script
├── background.js           # Service worker
├── lib/
│   └── dom-matcher.js      # Element matching engine
├── services/
│   ├── vision-service.js   # Gemini Vision API
│   ├── screenshot-service.js
│   └── state-manager.js   # State persistence
├── popup/
│   ├── popup.html
│   └── popup.js
├── styles/
│   └── widget.css         # Widget styling
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── docs/                   # Design documentation
└── README.md
```

## Usage

### Starting a Workflow

1. Open any webpage
2. Click the ScreenPilot extension icon
3. Enter your goal (e.g., "compose a mail", "search for...")
4. Click "Go"
5. Follow the highlighted instructions

### During a Workflow

- **Click** highlighted elements to advance
- **Type** in highlighted input fields (auto-detected)
- **Focus/blur** on fields triggers re-analysis
- **Page changes** automatically detected

### Ending a Workflow

- Click "Done" when task is complete
- Click "Cancel" to abort
- Workflow auto-completes when goal is reached

## Debug Mode

Check console for detailed logs:

```
[UniversalPlanner] Goal: ...
[UniversalPlanner] Target: ...
[PageObserver] Reanalysis triggered: ...
[VisionService] result — step: ...
```

## License

MIT License