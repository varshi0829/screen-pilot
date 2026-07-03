// State Machine Transitions — Unit Tests
// Run: node extension/tests/transitions.test.mjs

import { strict as assert } from 'node:assert';
import { test }             from 'node:test';

import {
  TaskState,
  TaskEvent,
  transition,
  isValidTransition,
} from '../shared/state-machine/transitions.js';

// ── RECOVERING: Architecture B loop-back paths ────────────────────────────────

test('RECOVERING + REPLAN_TRIGGERED → PLANNING', () => {
  assert.equal(
    transition(TaskState.RECOVERING, TaskEvent.REPLAN_TRIGGERED),
    TaskState.PLANNING,
  );
});

test('RECOVERING + PLAN_FAILED → ERROR', () => {
  assert.equal(
    transition(TaskState.RECOVERING, TaskEvent.PLAN_FAILED),
    TaskState.ERROR,
  );
});

// ── RECOVERING: events that must remain invalid ───────────────────────────────

test('RECOVERING + PLAN_RECEIVED → null (only valid from PLANNING)', () => {
  assert.equal(
    transition(TaskState.RECOVERING, TaskEvent.PLAN_RECEIVED),
    null,
  );
});

// ── Full Architecture B sequences ─────────────────────────────────────────────

test('EXECUTING → ELEMENT_NOT_FOUND → RECOVERING → REPLAN_TRIGGERED → PLANNING', () => {
  let state = TaskState.EXECUTING;

  state = transition(state, TaskEvent.ELEMENT_NOT_FOUND);
  assert.equal(state, TaskState.RECOVERING, 'ELEMENT_NOT_FOUND: EXECUTING → RECOVERING');

  state = transition(state, TaskEvent.REPLAN_TRIGGERED);
  assert.equal(state, TaskState.PLANNING, 'REPLAN_TRIGGERED: RECOVERING → PLANNING');
});

test('EXECUTING → ELEMENT_NOT_FOUND → RECOVERING → PLAN_FAILED → ERROR', () => {
  let state = TaskState.EXECUTING;

  state = transition(state, TaskEvent.ELEMENT_NOT_FOUND);
  assert.equal(state, TaskState.RECOVERING, 'ELEMENT_NOT_FOUND: EXECUTING → RECOVERING');

  state = transition(state, TaskEvent.PLAN_FAILED);
  assert.equal(state, TaskState.ERROR, 'PLAN_FAILED: RECOVERING → ERROR');
});

test('full replan cycle: EXECUTING → RECOVERING → PLANNING → EXECUTING', () => {
  let state = TaskState.EXECUTING;

  state = transition(state, TaskEvent.ELEMENT_NOT_FOUND);
  assert.equal(state, TaskState.RECOVERING);

  state = transition(state, TaskEvent.REPLAN_TRIGGERED);
  assert.equal(state, TaskState.PLANNING);

  state = transition(state, TaskEvent.PLAN_RECEIVED);
  assert.equal(state, TaskState.EXECUTING);
});

// ── isValidTransition mirrors transition() ────────────────────────────────────

test('isValidTransition: RECOVERING + REPLAN_TRIGGERED → true', () => {
  assert.equal(isValidTransition(TaskState.RECOVERING, TaskEvent.REPLAN_TRIGGERED), true);
});

test('isValidTransition: RECOVERING + PLAN_FAILED → true', () => {
  assert.equal(isValidTransition(TaskState.RECOVERING, TaskEvent.PLAN_FAILED), true);
});

test('isValidTransition: RECOVERING + PLAN_RECEIVED → false', () => {
  assert.equal(isValidTransition(TaskState.RECOVERING, TaskEvent.PLAN_RECEIVED), false);
});
