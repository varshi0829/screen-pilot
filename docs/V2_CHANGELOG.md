# ScreenPilot V2 Changelog

## [2.0.0-alpha] — 2026-08-27

### Added
- **Local-First Architecture**: Transitioned ScreenPilot to a 3-tier hierarchical local agent.
- **Local Qwen Integration**: Added support for local Ollama server running `qwen2.5-coder:7b`.
- **Generic Page State Extraction**: Created normalized DOM state extraction schema (`id`, `role`, `tag`, `text`, `placeholder`, `ariaLabel`, `visible`, `enabled`).
- **UI Element Grounding Model**: Added Layer 2 feature-vector scoring algorithm for ranking candidate DOM elements.
- **Decision Router**: Implemented 3-tier cascade (`DETERMINISTIC_THRESHOLD = 0.85`, `ML_GROUNDING_THRESHOLD = 0.70`).
- **1-Action Planning Loop**: Replaced multi-step plans with iterative 1-action execution and state verification.
- **Documentation Suite**: Added full set of V2 architecture, design, performance, and testing specifications in `docs/`.

### Improved
- **Stale Plan Protection**: Enhanced pre/post DOM hash and URL fingerprint checks with `AbortSignal` support.
- **Verification Delay**: Replaced 600ms fixed sleep with 150ms condition-based polling.
- **Soft Navigation Resume**: Reduced soft navigation resume timer to 200ms.
- **Repeated Action Safeguards**: Enhanced generic Dedup guard checking recent step history and state baselines.
