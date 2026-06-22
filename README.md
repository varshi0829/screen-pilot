# ScreenPilot

A Chrome extension that guides users through any web software step by step. Click the icon on any tab, type what you want to do, and ScreenPilot captures the page, sends it to Gemini 2.5 Flash, and puts a pulsing highlight on exactly what to click next.

No API key required. No per-site configuration. No hardcoded workflows.

---

## How it works

```
User types goal
      ↓
Content script captures visible tab (captureVisibleTab)
      ↓
Background worker sends screenshot + URL + goal to backend
      ↓
Backend (Next.js API route on Vercel) calls Gemini 2.5 Flash
      ↓
Gemini returns: candidates[], targetElement, instruction, confidence
      ↓
UniversalPlanner ranks candidates by 8 generic DOM signals
      ↓
DOMMatcher resolves best candidate against live DOM
      ↓
Highlight ring + arrow + instruction bubble appear over the element
      ↓
MutationObserver watches for DOM changes → re-plans automatically
```

---

## Install the extension (for users)

1. Download `screenpilot-extension.zip` from the landing page
2. Go to `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the extracted `extension/` folder — the one containing `manifest.json`
6. Open any webpage, click the ScreenPilot icon, type your goal

---

## Run locally (for developers)

### Backend

```bash
# Clone the repo
git clone https://github.com/varshi0829/screen-pilot.git
cd screen-pilot

# Install dependencies
npm install

# Create .env.local with your Gemini key
# Get a free key at: https://aistudio.google.com/apikey
echo "GEMINI_API_KEY=your_key_here" > .env.local

# Start dev server
npm run dev
# Landing page: http://localhost:3000
# API endpoint: http://localhost:3000/api/analyze
```

### Extension

Point the extension at your local backend while developing:

In `extension/services/vision-service.js`, change:
```js
const BACKEND_URL = 'https://screen-pilot.vercel.app/api/analyze';
// → 
const BACKEND_URL = 'http://localhost:3000/api/analyze';
```

Then load the `extension/` folder via `chrome://extensions/ → Load unpacked`.

---

## Deploy to Vercel

1. Push to GitHub
2. Import the repo in Vercel (no Root Directory setting needed — Next.js is at the repo root)
3. Add environment variable: `GEMINI_API_KEY = your_key`
4. Deploy

---

## Architecture

### Application-agnostic design

ScreenPilot has no built-in knowledge of any website or application. Every decision is derived from:

- The current screenshot (what Gemini sees)
- The DOM state (what elements are actually present)
- The user's goal (plain English)
- The history of completed steps

There are no `if (url.includes('gmail'))` branches. No per-site element selectors. No hardcoded step sequences.

### Backend (`src/app/api/analyze/route.ts`)

- Receives `{ screenshot, goal, pageContext, taskState }` from the extension
- Builds the Gemini prompt server-side (never exposes the API key)
- Rate-limits to 12 requests per minute per session UUID
- Returns Gemini's raw response; parsing stays in the extension

### Content script (`extension/content.js`)

- **Widget**: Floating UI injected into the active tab
- **PerfTracer**: Measures each phase of a cycle (cache hit / Gemini round-trip / DOM match / highlight) and prints a structured table in DevTools
- **PageStateCache**: Caches the last Gemini response keyed by `URL + goal + DOM fingerprint`. Invalidated when the DOM changes or after 25 seconds. Prevents redundant API calls on repeated `Go` with identical page state.
- **UniversalPlanner**: Ranks Gemini's `candidates[]` using 8 generic signals: Gemini confidence, DOM match score, clickability, semantic similarity, visibility, action type weight, region weight, visual prominence
- **PageObserver**: `MutationObserver` + popstate/hashchange — triggers re-analysis on DOM changes, automatically invalidating the cache

### DOM Matcher (`extension/lib/dom-matcher.js`)

Resolves an element description to a live DOM node using:

- Exact text match (score 110)
- Synonym match via generic synonym table (score 102)
- Token similarity / reordering (score 72–98)
- Substring containment (score 70)
- Levenshtein distance ≤ 2 (score 48–64)
- Semantic container context bonus (+10–18)
- Element type affinity bonus (+10)

Synonym table contains only generic UI verbs (`upload/attach`, `submit/send/confirm`, `cancel/dismiss`, etc.) — no application names.

### Performance profile

Open Chrome DevTools → Console on any page where ScreenPilot runs and look for:

```
[ScreenPilot Perf] 3842ms — "schedule an email for tomorrow"
┌─────────────────────┬──────────────────┬──────────────────┐
│ phase               │ ms (cumulative)  │ ms (this phase)  │
├─────────────────────┼──────────────────┼──────────────────┤
│ gemini_roundtrip    │ 3761             │ 3761             │
│ dom_match           │ 3798             │ 37               │
│ highlight           │ 3842             │ 44               │
└─────────────────────┴──────────────────┴──────────────────┘
```

Typical breakdown: Gemini latency is ~95% of total time. Screenshot capture and compression are ~100–200ms (inside the Gemini phase). DOM matching and highlighting are negligible.

The `cache_hit` phase appears instead of `gemini_roundtrip` when the page state hasn't changed:
```
[Cache] HIT — returning cached analysis (same URL + goal + DOM)
[ScreenPilot Perf] 41ms — "schedule an email for tomorrow"
```

---

## Project structure

```
screen-pilot/
├── extension/                  ← Chrome extension (load this folder in Chrome)
│   ├── manifest.json           ← MV3
│   ├── background.js           ← Service worker: orchestration
│   ├── content.js              ← Widget, UniversalPlanner, PageStateCache, PerfTracer
│   ├── lib/
│   │   └── dom-matcher.js      ← DOM element resolution
│   ├── services/
│   │   ├── vision-service.js   ← Backend API caller
│   │   ├── screenshot-service.js
│   │   └── state-manager.js
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.js
│   ├── styles/widget.css
│   └── icons/
├── src/                        ← Next.js landing page
│   ├── app/
│   │   ├── api/analyze/
│   │   │   └── route.ts        ← Gemini proxy endpoint
│   │   ├── layout.tsx
│   │   └── page.tsx
│   └── components/
├── public/
│   ├── demo.mp4
│   └── screenpilot-extension.zip
├── next.config.ts
├── package.json
└── .env.example                ← Copy to .env.local, add GEMINI_API_KEY
```

---

## License

MIT
