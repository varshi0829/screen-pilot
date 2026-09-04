# 18. Security and Privacy Considerations

## 18.1 Data Handling

| Data | Storage | Retention |
|------|--------|----------|
| User goal input | Memory only | Until workflow complete |
| Page DOM | Memory only | Until workflow complete |
| API keys | chrome.storage.local | Until manually removed |
| Workflow history | Not stored (MVP) | N/A |

## 18.2 Privacy Protections

| Protection | Implementation |
|------------|---------------|
| No persistent logs | Workflow state cleared on completion |
| No screenshot storage | DOM queried in-memory only |
| No third-party data sharing | Only Gemini API receives data |
| User consent | Extension only activates on user action |

## 18.3 API Key Security

- Store API key in `chrome.storage.local` (not localStorage)
- Key never exposed to content script
- Key sent only from background script to Gemini API
- Consider using Google AI Studio for key management