# Execution and Verification Engine Specification

## 1. Overview
The **Execution and Verification Engine** ensures that actions selected by the decision router are executed safely and validated against actual live browser state transitions.

---

## 2. Pre-Execution Safety Checks
Before dispatching an action to the browser DOM:
1. **Element Existence**: Confirm `elementId` maps to a live DOM element.
2. **Element Visibility**: Verify element is visible in the viewport (`width > 0 && height > 0`).
3. **Element Enabled State**: Verify element is not disabled (`!el.disabled`).
4. **State Baseline Hash**: Capture pre-action `PageSnapshot` (`preSnap.domHash`, `preSnap.url`).

---

## 3. Condition-Based Verification (150ms Max)
Fixed sleeps (`sleep(600)`) are eliminated. The verifier polls condition-based state transitions:

```javascript
const pre = executor.getPreActionSnapshot();
let post = capturePageSnapshot("");
const t0 = Date.now();
while (Date.now() - t0 < 150 && pre.domHash === post.domHash && pre.url === post.url) {
  await new Promise(r => setTimeout(r, 25));
  post = capturePageSnapshot("");
}
```
If DOM hash or URL changes within 150ms, verification settles immediately.

---

## 4. Stale-Plan Protection
Before dispatching a plan request, `preSnap` is captured. Upon response arrival, `postSnap` is captured. If `preSnap.url !== postSnap.url` or `preSnap.domHash !== postSnap.domHash`, the plan is marked stale, discarded, and replanned from current state.
