import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHandoffs, TOOL_ID } from '../src/index.mjs';

const board = { source: 'board-v1', assignee: 'team-a', title: 'Ship sample', references: ['doc-1'], completionCriteria: ['Check output'], dueAt: '2026-01-05T10:30:00+05:30', status: 'In Progress' };
const queue = { source: 'queue-v1', owner: 'team-b', objective: 'Review sample', contextRefs: ['doc-2'], acceptance: ['Approve result'], deadline: '2026-01-05T06:00:00Z', state: 'todo' };
const input = { schemaVersion: '1', tasks: [board, queue] };

test('two export shapes normalize to the same versioned task schema', () => {
  const r = normalizeHandoffs(input);
  assert.equal(TOOL_ID, 'task-handoff-normalizer');
  assert.equal(r.status, 'pass'); assert.equal(r.summary.checked, 2); assert.deepEqual(r.findings, []);
  assert.deepEqual(r.tasks, [
    { sourceOrdinal: 1, owner: 'team-a', objective: 'Ship sample', contextRefs: ['doc-1'], acceptance: ['Check output'], deadline: { original: '2026-01-05T10:30:00+05:30', utc: '2026-01-05T05:00:00Z' }, currentState: 'in-progress' },
    { sourceOrdinal: 2, owner: 'team-b', objective: 'Review sample', contextRefs: ['doc-2'], acceptance: ['Approve result'], deadline: { original: '2026-01-05T06:00:00Z', utc: '2026-01-05T06:00:00Z' }, currentState: 'todo' },
  ]);
});
test('missing owner and acceptance are located without echoing source payload', () => {
  const d = structuredClone(input); d.tasks[0].assignee = ''; d.tasks[1].acceptance = [];
  const r = normalizeHandoffs(d);
  assert.equal(r.status, 'incomplete'); assert.equal(r.summary.checked, 0);
  assert.deepEqual(r.findings.map(f => [f.ruleId, f.location.pointer]), [['owner-missing', '/tasks/0/assignee'], ['acceptance-missing', '/tasks/1/acceptance']]);
  assert.equal(JSON.stringify(r).includes('Ship sample'), false);
});
test('impossible deadline is incomplete, not rolled into another day', () => {
  const d = structuredClone(input); d.tasks[0].dueAt = '2026-02-30T10:30:00+05:30';
  const r = normalizeHandoffs(d);
  assert.equal(r.status, 'incomplete'); assert.equal(r.findings[0].ruleId, 'deadline-invalid');
});
test('unrecognized state is incomplete rather than guessed', () => {
  const d = structuredClone(input); d.tasks[1].state = 'maybe';
  const r = normalizeHandoffs(d);
  assert.equal(r.status, 'incomplete'); assert.equal(r.findings[0].ruleId, 'state-unknown');
});
test('same input produces byte-identical output', () => {
  assert.equal(JSON.stringify(normalizeHandoffs(input)), JSON.stringify(normalizeHandoffs(input)));
});
test('injected time bound accepts 5000 ms and rejects 5001 ms', () => {
  const clock = limit => { let first = true; return () => { if (first) { first = false; return 0; } return limit; }; };
  assert.equal(normalizeHandoffs(input, { now: clock(5000) }).status, 'pass');
  const over = normalizeHandoffs(input, { now: clock(5001) });
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'time-limit');
});
test('context reference count accepts 20 and rejects 21', () => {
  const d = structuredClone(input); d.tasks[0].references = Array.from({ length: 20 }, (_, i) => `doc-${i}`);
  assert.equal(normalizeHandoffs(d).status, 'pass');
  d.tasks[0].references.push('doc-20');
  const over = normalizeHandoffs(d);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'context-invalid');
});
test('acceptance count accepts 20 and rejects 21', () => {
  const d = structuredClone(input); d.tasks[1].acceptance = Array.from({ length: 20 }, (_, i) => `Check ${i}`);
  assert.equal(normalizeHandoffs(d).status, 'pass');
  d.tasks[1].acceptance.push('Check 20');
  const over = normalizeHandoffs(d);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'acceptance-missing');
});
test('objective length accepts 500 and rejects 501', () => {
  const d = structuredClone(input); d.tasks[0].title = 'x'.repeat(500);
  assert.equal(normalizeHandoffs(d).status, 'pass');
  d.tasks[0].title += 'x';
  const over = normalizeHandoffs(d);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'objective-missing');
});
test('owner alias accepts 128 and rejects 129 characters', () => {
  const d = structuredClone(input); d.tasks[0].assignee = 'x'.repeat(128);
  assert.equal(normalizeHandoffs(d).status, 'pass');
  d.tasks[0].assignee += 'x';
  const over = normalizeHandoffs(d);
  assert.equal(over.status, 'incomplete'); assert.equal(over.findings[0].ruleId, 'owner-missing');
});
test('valid task remains available when a later task is incomplete', () => {
  const d = structuredClone(input); d.tasks[1].owner = '';
  const r = normalizeHandoffs(d);
  assert.equal(r.status, 'incomplete'); assert.equal(r.summary.checked, 1);
  assert.deepEqual(r.tasks.map(t => t.sourceOrdinal), [1]);
  assert.equal(r.findings[0].location.pointer, '/tasks/1/owner');
});
test('control and bidi characters in prose are refused before rendering', () => {
  const d = structuredClone(input); d.tasks[0].title = 'private\u0085\u202e';
  const r = normalizeHandoffs(d);
  assert.equal(r.status, 'incomplete'); assert.equal(r.findings[0].ruleId, 'objective-missing');
  assert.equal(JSON.stringify(r).includes('private'), false);
  assert.equal(JSON.stringify(r).includes('\u202e'), false);
});
