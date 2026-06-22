// ScreenPilot - Storage Provider Abstraction
// Thin interface layer over chrome.storage that enables future backend migration.
//
// Current implementation: chrome.storage.local / chrome.storage.session
// Future implementations (swap-in without changing consumers):
//   - RedisProvider    (for shared rate limits and multi-device sync)
//   - UpstashProvider  (serverless Redis via HTTP)
//   - PostgresProvider (for analytics and audit trails)
//
// Interface contract (all providers must implement):
//   get(key)              → Promise<any | null>
//   set(key, value)       → Promise<void>
//   remove(key)           → Promise<void>
//   getMultiple(keys[])   → Promise<Record<string, any>>
//   setMultiple(obj)      → Promise<void>
//
// Usage:
//   import { StorageProvider, SessionProvider } from './storage-provider.js';
//   const storage = StorageProvider.getProvider();
//   const value   = await storage.get('my-key');

// ─── LOCAL STORAGE PROVIDER ──────────────────────────────────────────────────
// Backed by chrome.storage.local — persists across sessions, survives restarts.

const _LocalStorageProvider = {
  name: 'LocalStorageProvider',

  async get(key) {
    const result = await chrome.storage.local.get(key);
    return key in result ? result[key] : null;
  },

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  async remove(key) {
    await chrome.storage.local.remove(key);
  },

  async getMultiple(keys) {
    return chrome.storage.local.get(keys);
  },

  async setMultiple(obj) {
    await chrome.storage.local.set(obj);
  },
};

// ─── SESSION STORAGE PROVIDER ────────────────────────────────────────────────
// Backed by chrome.storage.session — cleared when browser closes.
// Used for active task state that should not persist across restarts.

const _LocalSessionProvider = {
  name: 'LocalSessionProvider',

  async get(key) {
    const result = await chrome.storage.session.get(key);
    return key in result ? result[key] : null;
  },

  async set(key, value) {
    await chrome.storage.session.set({ [key]: value });
  },

  async remove(key) {
    await chrome.storage.session.remove(key);
  },

  async getMultiple(keys) {
    return chrome.storage.session.get(keys);
  },

  async setMultiple(obj) {
    await chrome.storage.session.set(obj);
  },
};

// ─── PROVIDER REGISTRY ───────────────────────────────────────────────────────
// Validates that a provider conforms to the interface before accepting it.

function _assertProvider(provider) {
  const required = ['get', 'set', 'remove', 'getMultiple', 'setMultiple'];
  for (const method of required) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`StorageProvider: missing required method "${method}"`);
    }
  }
}

// ─── PERSISTENT STORAGE (chrome.storage.local) ───────────────────────────────
// Used for: analytics, memory, rate limits, session ID

export const StorageProvider = (() => {
  let _active = _LocalStorageProvider;

  /** Replace the active provider (all future calls route through the new one). */
  function setProvider(provider) {
    _assertProvider(provider);
    _active = provider;
  }

  /** Get the currently active provider instance. */
  function getProvider() {
    return _active;
  }

  return { setProvider, getProvider, LocalProvider: _LocalStorageProvider };
})();

// ─── SESSION STORAGE (chrome.storage.session) ────────────────────────────────
// Used for: active task state (intentionally ephemeral)

export const SessionProvider = (() => {
  let _active = _LocalSessionProvider;

  function setProvider(provider) {
    _assertProvider(provider);
    _active = provider;
  }

  function getProvider() {
    return _active;
  }

  return { setProvider, getProvider, LocalProvider: _LocalSessionProvider };
})();
