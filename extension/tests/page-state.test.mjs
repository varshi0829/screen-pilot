// ScreenPilot v2 — Page State Extraction Unit Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { PageStateService } from '../services/page-state-service.js';

function mockDoc() {
  const elements = [
    {
      tagName: 'INPUT',
      getAttribute: (k) => k === 'placeholder' ? 'Search products' : null,
      innerText: '',
      textContent: '',
      offsetParent: {},
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 200, height: 30 }),
      closest: () => null
    },
    {
      tagName: 'BUTTON',
      getAttribute: (k) => k === 'aria-label' ? 'Submit Search' : null,
      innerText: 'Search',
      textContent: 'Search',
      offsetParent: {},
      getBoundingClientRect: () => ({ x: 220, y: 10, width: 80, height: 30 }),
      closest: (sel) => sel.includes('nav') ? {} : null
    }
  ];

  return {
    title: 'Test Store Page',
    querySelectorAll: () => elements
  };
}

function mockLoc() {
  return { href: 'https://store.example.com/search' };
}

test('PageStateService extracts normalized website-agnostic page state', () => {
  const doc = mockDoc();
  const loc = mockLoc();

  const state = PageStateService.extractPageState({ doc, loc });

  assert.equal(state.url, 'https://store.example.com/search');
  assert.equal(state.title, 'Test Store Page');
  assert.equal(state.elements.length, 2);

  const inputEl = state.elements[0];
  assert.equal(inputEl.id, 'el_1');
  assert.equal(inputEl.role, 'textbox');
  assert.equal(inputEl.tag, 'input');
  assert.equal(inputEl.placeholder, 'Search products');
  assert.equal(inputEl.visible, true);
  assert.equal(inputEl.enabled, true);

  const buttonEl = state.elements[1];
  assert.equal(buttonEl.id, 'el_2');
  assert.equal(buttonEl.role, 'button');
  assert.equal(buttonEl.tag, 'button');
  assert.equal(buttonEl.text, 'Search');
  assert.equal(buttonEl.ariaLabel, 'Submit Search');
});
