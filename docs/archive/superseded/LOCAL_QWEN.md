# Local Qwen Integration Specification

## 1. Overview
ScreenPilot V2 uses a **locally hosted Qwen model** (`qwen2.5-coder:7b`) as the reasoning fallback layer when deterministic heuristics or the small ML grounding model do not reach the required confidence threshold.

No cloud API calls or external API keys are required for local operation.

---

## 2. Environment & Hardware Compatibility

### 2.1 Hardware Requirements & Profile
- **CPU**: Intel Core i5-1135G7 (8 logical threads)
- **RAM**: 14 GB System Memory
- **GPU**: Intel Iris Xe Integrated Graphics (CPU-only GGUF execution)
- **Quantization**: 4-bit Medium (`Q4_K_M`)
- **Memory Footprint**: ~4.7 GB RAM in process space

### 2.2 Local Inference Server (Ollama)
- **Server Address**: `http://127.0.0.1:11434`
- **Primary Endpoint**: `/api/generate` or `/api/chat`
- **Default Model**: `qwen2.5-coder:7b` (digest `dae161e27b0e`)
- **Format**: `gguf`
- **Evaluation Speed**: ~1.5–2.5 seconds per prompt on CPU.

---

## 3. Communication Protocol

The local extension backend adapter (`LocalQwenAdapter`) sends HTTP POST requests to `http://127.0.0.1:11434/api/generate`:

### 3.1 Request Payload
```json
{
  "model": "qwen2.5-coder:7b",
  "prompt": "<structured_prompt>",
  "format": "json",
  "stream": false,
  "options": {
    "temperature": 0.1,
    "num_predict": 256
  }
}
```

### 3.2 Structured Output Schema
Local Qwen is prompted to output strictly valid JSON conforming to:

```json
{
  "action": "click",
  "elementId": "el_17",
  "text": "Submit",
  "confidence": 0.92,
  "reason": "Matching action for search form submission."
}
```

### 3.3 Supported Action Types
- `click`: Click on element `elementId`.
- `type`: Enter text into `elementId` (requires `"value"` field).
- `select`: Select option in `elementId`.
- `scroll`: Scroll viewport (`"direction": "down" | "up"`).
- `navigate`: Navigate to `"url"`.
- `wait`: Pause briefly for dynamic content.
- `finish`: Terminate task (goal complete).

Arbitrary code execution or raw JavaScript generation is strictly forbidden.
