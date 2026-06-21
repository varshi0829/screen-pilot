# 17. Extension Permissions and Justification

## 17.1 Required Permissions

| Permission | Justification |
|------------|---------------|
| `activeTab` | Access current page DOM for element finding |
| `scripting` | Inject content script to run in page context |
| `storage` | Persist workflow state and preferences |
| `tabs` | Read current tab URL for context |
| `host_permissions` | Access all URLs (for cross-site support) |

## 17.2 Manifest V3 Configuration

```json
{
  "manifest_version": 3,
  "name": "ScreenPilot",
  "version": "1.0.0",
  "permissions": [
    "activeTab",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_title": "ScreenPilot"
  }
}
```

## 17.3 Permission Rationale

| Permission | Why Required |
|------------|------------|
| `<all_urls>` | MVP targets multiple sites (Gmail, GitHub, Jira). Cannot predict all URLs in advance. |
| `activeTab` | Only access the tab the user activates on, not all tabs. |
| `scripting` | Required to execute content script in page context. |