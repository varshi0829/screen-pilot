# ScreenPilot V2 — Local Qwen Integration & Hardware Benchmarking

## 1. Model Selection & Hardware Constraints

### Target Hardware Profile
- **CPU**: Intel Core i5-1135G7 (8 logical cores)
- **RAM**: 14 GB System Memory
- **GPU**: Intel Iris Xe Integrated Graphics (CPU GGUF inference, no NVIDIA GPU)

### Empirical Benchmark Results
| Model | Cold Start (1st Request) | Model Loading Time | Warm Request Latency | Warm Load Overhead | Selection Decision |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`qwen2.5-coder:7b`** | **~17.5 s** | **~9.5 s** | **~5.7 s** | **~0.4 s** | **SELECTED (Fast & Accurate)** |
| `qwen3:latest` | ~108.9 s | ~97.9 s | ~45.0 s | ~12.0 s | REJECTED (Too slow on CPU) |

> **Decision Rationale**: `qwen2.5-coder:7b` is dramatically faster on Intel i5 CPU / 14 GB RAM hardware (~5.7s warm vs ~45s warm for qwen3). `qwen3:latest` is strictly avoided due to extreme latency overhead.

---

## 2. Ollama Configuration & Warm-Model Strategy

ScreenPilot V2 connects to local Ollama running at `http://127.0.0.1:11434`.

To prevent repeated model loading overheads (which add 9.5s to every inference cycle), ScreenPilot passes `"keep_alive": "5m"` in all `/api/generate` calls:

```json
{
  "model": "qwen2.5-coder:7b",
  "prompt": "<compact_prompt>",
  "format": "json",
  "stream": false,
  "keep_alive": "5m",
  "options": {
    "temperature": 0,
    "num_predict": 128
  }
}
```

### Key Parameters:
- `keep_alive`: `"5m"` keeps the model resident in process memory for 5 minutes after each request.
- `temperature`: `0` yields deterministic, reproducible outputs.
- `num_predict`: `128` restricts response length to tiny structured JSON objects.

---

## 3. Tiny Action JSON Output

Qwen is prompted to output strictly tiny structured JSON payloads:

```json
{
  "action": "click",
  "elementId": "el_17",
  "confidence": 0.96
}
```

Or for form input:

```json
{
  "action": "type",
  "elementId": "el_5",
  "text": "search keyword",
  "confidence": 0.94
}
```

Verbose natural-language commentary, arbitrary JavaScript execution, or multi-step plans are avoided.
