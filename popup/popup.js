// ScreenPilot - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('openWidget');
  const statusEl = document.getElementById('status');

  openBtn.addEventListener('click', async () => {
    console.log('[Popup] Open clicked');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) throw new Error('No active tab found');

      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') ||
          tab.url?.startsWith('edge://') || tab.url?.startsWith('about:')) {
        statusEl.textContent = 'ScreenPilot cannot run on browser internal pages';
        statusEl.className = 'status error';
        return;
      }

      // Try sending directly first (manifest already injected content script)
      try {
        console.log('[Popup] first OPEN_WIDGET send');
        await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_WIDGET' });
        window.close();
        return;
      } catch (err) {
        console.log('[Popup] first sendMessage failed', err?.message);
        // Content script not present yet — fall through to inject
      }

      // Fallback injection for pages loaded before extension was installed
      console.log('[Popup] Injecting dom-matcher');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/dom-matcher.js'] });
      console.log('[Popup] Injecting content.js');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      console.log('[Popup] CSS injected');
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles/widget.css'] });
      await new Promise(resolve => setTimeout(resolve, 150));
      console.log('[Popup] Sending OPEN_WIDGET');
      await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_WIDGET' });
      window.close();
    } catch (error) {
      statusEl.textContent = 'Could not open ScreenPilot: ' + error.message;
      statusEl.className = 'status error';
    }
  });
});
