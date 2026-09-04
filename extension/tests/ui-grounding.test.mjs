// ScreenPilot v2 — UI Grounding Model Unit Tests

import test from 'node:test';
import assert from 'node:assert/strict';
import { UIGroundingService } from '../services/ui-grounding-service.js';

test('UIGroundingService ranks candidate elements by intent relevance', () => {
  const elements = [
    { id: 'el_1', role: 'textbox', tag: 'input', placeholder: 'Search products', visible: true, enabled: true },
    { id: 'el_2', role: 'button', tag: 'button', text: 'Submit Order', visible: true, enabled: true },
    { id: 'el_3', role: 'link', tag: 'a', text: 'Contact Us', visible: true, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('Search products', elements);

  assert.equal(ranked.length > 0, true);
  assert.equal(ranked[0].element.id, 'el_1', 'Search input element should rank top for Search products');
  assert.ok(ranked[0].score >= 0.70, 'Search input score should meet or exceed 0.70 threshold');
});

test('UIGroundingService assigns zero score to invisible elements', () => {
  const elements = [
    { id: 'el_1', role: 'button', tag: 'button', text: 'Hidden Button', visible: false, enabled: true }
  ];

  const ranked = UIGroundingService.rankElements('Click Hidden Button', elements);
  assert.equal(ranked.length, 0, 'Invisible elements must be excluded from ranking');
});
