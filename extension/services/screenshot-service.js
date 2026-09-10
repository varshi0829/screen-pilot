// ScreenPilot - Screenshot Service

export const ScreenshotService = (() => {
  'use strict';

  const CAPTURE_TIMEOUT_MS    = 8000;
  const MAX_CAPTURE_ATTEMPTS  = 2;
  const MAX_WIDTH             = 1024;   // resize larger screens down (1024px)
  const JPEG_QUALITY          = 0.70;   // good fidelity, optimized payload size

  // @param {object[]} [sensitiveRegions] - CSS-pixel bboxes ({x,y,width,height})
  //   of sensitive DOM elements (see PrivacySanitizer.getSensitiveRegions),
  //   supplied by the caller from the same-cycle page state. Defaults to none,
  //   so existing callers that don't pass it get byte-identical output to
  //   before this change.
  // @param {number} [devicePixelRatio] - the tab's window.devicePixelRatio at
  //   capture time, needed to map CSS-pixel bboxes onto the physical-pixel
  //   screenshot chrome.tabs.captureVisibleTab returns.
  async function captureVisibleTab(windowId, sensitiveRegions = [], devicePixelRatio = 1) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
      try {
        const captureWindowId = await resolveWindowId(windowId);

        const t0 = Date.now();
        const dataUrl = await withTimeout(
          chrome.tabs.captureVisibleTab(captureWindowId, { format: 'png' }),
          CAPTURE_TIMEOUT_MS,
          'Timed out while capturing the current tab.'
        );
        console.log(`[Perf] Screenshot capture: ${Date.now() - t0}ms`);

        if (!dataUrl?.startsWith('data:image/')) {
          throw new Error('Chrome did not return a usable screenshot.');
        }

        // Resize + JPEG compress via OffscreenCanvas — sensitive regions are
        // masked opaque black inside this step, before any bytes exist that
        // could be serialized into a cloud request.
        const t1 = Date.now();
        const compressed = await compressImage(dataUrl, sensitiveRegions, devicePixelRatio);
        console.log(`[Perf] Screenshot compress: ${Date.now() - t1}ms (${Math.round(compressed.image.length / 1024)}KB)`);

        return {
          success:   true,
          image:     compressed.image,
          mimeType:  'image/jpeg',
          timestamp: Date.now(),
          attempts:  attempt
        };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      success: false,
      error:   normalizeCaptureError(lastError)
    };
  }

  async function compressImage(dataUrl, sensitiveRegions = [], devicePixelRatio = 1) {
    // Native fetch decode — avoids manual base64→bytes loop entirely
    const blob   = await fetch(dataUrl).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);

    const scale  = Math.min(1, MAX_WIDTH / bitmap.width);
    const width  = Math.floor(bitmap.width  * scale);
    const height = Math.floor(bitmap.height * scale);

    const canvas = new OffscreenCanvas(width, height);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // Sensitive DOM regions (password/email/etc. fields) are in CSS pixels
    // relative to the page; the captured bitmap is in physical pixels and has
    // since been resized by `scale` — both factors have to be applied to land
    // on the right rectangle. Masked BEFORE convertToBlob, so an unredacted
    // frame never exists past this point.
    const redactionRects = computeRedactionRects(sensitiveRegions, devicePixelRatio * scale, width, height);
    if (redactionRects.length) {
      ctx.fillStyle = '#000000';
      for (const r of redactionRects) ctx.fillRect(r.x, r.y, r.width, r.height);
    }

    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const buffer  = await outBlob.arrayBuffer();

    // Chunked encode — ~10× faster than character-by-character loop
    const image = uint8ToBase64(new Uint8Array(buffer));
    return { image };
  }

  /**
   * Pure geometry helper — scales CSS-pixel DOM bboxes into the resized
   * canvas's pixel space and clips them to its bounds. No canvas/image APIs,
   * so it's directly unit-testable outside a browser.
   *
   * @param {object[]} sensitiveRegions - [{x,y,width,height}] in CSS pixels
   * @param {number} combinedScale - devicePixelRatio * the canvas resize scale
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @returns {{x:number,y:number,width:number,height:number}[]}
   */
  function computeRedactionRects(sensitiveRegions, combinedScale, canvasWidth, canvasHeight) {
    if (!Array.isArray(sensitiveRegions) || !sensitiveRegions.length) return [];
    return sensitiveRegions
      .filter(r => r && r.width > 0 && r.height > 0)
      .map(r => {
        const x = Math.max(0, Math.floor(r.x * combinedScale));
        const y = Math.max(0, Math.floor(r.y * combinedScale));
        const width  = Math.max(0, Math.min(Math.ceil(r.width  * combinedScale), canvasWidth  - x));
        const height = Math.max(0, Math.min(Math.ceil(r.height * combinedScale), canvasHeight - y));
        return { x, y, width, height };
      })
      .filter(r => r.width > 0 && r.height > 0);
  }

  function uint8ToBase64(bytes) {
    const CHUNK = 8192;
    let str = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(str);
  }

  async function resolveWindowId(windowId) {
    if (typeof windowId === 'number') return windowId;
    const win = await chrome.windows.getCurrent();
    return win.id;
  }

  function validateScreenshot(screenshot) {
    if (!screenshot?.success) {
      return { valid: false, error: screenshot?.error || 'Unable to capture the current page.' };
    }
    if (!screenshot.image || screenshot.image.length < 1000) {
      return { valid: false, error: 'The screenshot was too small to analyze.' };
    }
    return { valid: true };
  }

  function normalizeCaptureError(error) {
    const msg = error?.message || 'Unknown screenshot error';
    if (msg.includes('activeTab') || msg.includes('permission'))
      return 'ScreenPilot needs tab access to capture the page.';
    if (msg.includes('No tab with id') || msg.includes('No current window'))
      return 'Could not find the active browser tab.';
    return `Screenshot failed: ${msg}`;
  }

  function withTimeout(promise, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      promise
        .then(r  => { clearTimeout(timer); resolve(r); })
        .catch(e => { clearTimeout(timer); reject(e);  });
    });
  }

  return { captureVisibleTab, validateScreenshot, computeRedactionRects };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScreenshotService;
}
