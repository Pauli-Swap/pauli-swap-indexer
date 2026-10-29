import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tooCostly } from '../src/api.js';

const aliases = (field: string, n: number) => `{ ${Array.from({ length: n }, (_, i) => `a${i}: ${field}`).join(' ')} }`;

test('api cost: aliases and fragments count as root fields', () => {
  assert.equal(tooCostly('{ _meta { block } }'), null);
  assert.equal(tooCostly('query($day: Int) { questQueue(day: $day) { user } }'), null);
  assert.equal(tooCostly(aliases('_meta { block }', 10)), null);
  assert.match(tooCostly(aliases('_meta { block }', 11))!, /root fields/);
  assert.match(tooCostly(aliases('questQueue { user }', 2))!, /questQueue/);
  assert.match(tooCostly('fragment F on Query { a: questQueue { user } b: questProgress(user: "x") { day } } { ...F }')!, /questQueue/);
  assert.match(tooCostly('{ ... on Query { a: predictLeaderboard { total } } b: predictLeaderboard { total } }')!, /predictLeaderboard/);
  assert.equal(tooCostly('fragment F on Query { ...F } { ...F }'), null);
  assert.equal(tooCostly('{ not graphql'), null);
});
