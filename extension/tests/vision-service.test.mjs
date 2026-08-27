// ScreenPilot v2 — VisionService backend URL config tests
// Run: node extension/tests/vision-service.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const _store = {};

global.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: _store[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, _store[k]]));
        return { ..._store };
      },
      async set(obj) { Object.assign(_store, obj); },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete _store[k];
      },
    },
  },
};

const { VisionService } = await import('../services/vision-service.js');

test('VisionService uses the deployed backend URL by default', async () => {
  for (const k of Object.keys(_store)) delete _store[k];
  assert.equal(
    await VisionService.__resolveBackendUrlForTests(),
    'https://screen-pilot-j1az.vercel.app/api/analyze'
  );
});

test('VisionService honors a stored backend URL override', async () => {
  for (const k of Object.keys(_store)) delete _store[k];
  await chrome.storage.local.set({ screenPilotBackendUrl: 'http://localhost:3000/api/analyze' });
  assert.equal(
    await VisionService.__resolveBackendUrlForTests(),
    'http://localhost:3000/api/analyze'
  );
});
