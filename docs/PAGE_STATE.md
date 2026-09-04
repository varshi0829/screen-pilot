# Page State Representation Specification

## 1. Overview
ScreenPilot V2 extracts a **website-agnostic, normalized JSON representation** of the active web page. 

Raw full HTML strings are never sent to local ML models or LLMs. Raw HTML contains excessive boilerplate (CSS classes, script tags, metadata) that bloats token counts and slows down local CPU inference.

---

## 2. Element Extraction Schema

Each interactive or structurally relevant DOM element is mapped to a normalized JSON object:

```json
{
  "id": "el_17",
  "role": "textbox",
  "tag": "input",
  "text": "",
  "placeholder": "Search products",
  "ariaLabel": "Search",
  "value": "",
  "href": "",
  "visible": true,
  "enabled": true,
  "region": "top_navigation",
  "bbox": { "x": 120, "y": 15, "width": 240, "height": 36 }
}
```

### 2.1 Schema Attributes
- `id`: Stable, temporary session-scoped element ID (e.g. `el_1`, `el_2`).
- `role`: Accessible ARIA role (`button`, `link`, `textbox`, `combobox`, `tab`, etc.).
- `tag`: HTML tag name (`button`, `a`, `input`, `select`, `textarea`).
- `text`: Visible inner text (trimmed, truncated to 80 chars).
- `placeholder`: Input placeholder attribute value.
- `ariaLabel`: `aria-label`, `title`, or `img[alt]` accessible label.
- `value`: Current form field value (if applicable).
- `href`: Link target URL (relative or absolute, truncated if long).
- `visible`: Boolean indicating element viewport visibility (`width > 0 && height > 0`).
- `enabled`: Boolean indicating whether element is non-disabled (`!el.disabled`).
- `region`: Page layout region (`top_navigation`, `side_navigation`, `main_content`, `toolbar`, `modal`, `footer`).

---

## 3. Page Context Container

The full page state object wraps extracted elements with high-level page metadata:

```json
{
  "url": "https://example.org/products",
  "title": "Products — Example Store",
  "elements": [
    { "id": "el_1", "role": "link", "tag": "a", "text": "Home", "visible": true, "enabled": true },
    { "id": "el_2", "role": "textbox", "tag": "input", "placeholder": "Search", "visible": true, "enabled": true }
  ],
  "domHash": "9c261850",
  "timestamp": 1787820000000
}
```

---

## 4. Website Independence
The page-state extraction algorithm uses standard DOM traversal and ARIA accessibility criteria. It contains zero hardcoded site selectors (`#github-search`, `.yt-button`), domain checks (`if (github)`), or site-specific rules.
