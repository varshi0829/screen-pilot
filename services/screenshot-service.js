// ScreenPilot - Screenshot Service

export const ScreenshotService = (() => {
  'use strict';

  const CAPTURE_TIMEOUT_MS    = 8000;
  const MAX_CAPTURE_ATTEMPTS  = 2;
  const MAX_WIDTH             = 1280;   // resize larger screens down
  const JPEG_QUALITY          = 0.82;   // good fidelity, ~3-4× smaller than PNG

  async function captureVisibleTab(windowId) {
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

        // Resize + JPEG compress via OffscreenCanvas
        const t1 = Date.now();
        const compressed = await compressImage(dataUrl);
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

  async function compressImage(dataUrl) {
    // Native fetch decode — avoids manual base64→bytes loop entirely
    const blob   = await fetch(dataUrl).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);

    const scale  = Math.min(1, MAX_WIDTH / bitmap.width);
    const width  = Math.floor(bitmap.width  * scale);
    const height = Math.floor(bitmap.height * scale);

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const buffer  = await outBlob.arrayBuffer();

    // Chunked encode — ~10× faster than character-by-character loop
    const image = uint8ToBase64(new Uint8Array(buffer));
    return { image };
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

  return { captureVisibleTab, validateScreenshot };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScreenshotService;
}
