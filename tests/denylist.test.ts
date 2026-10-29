import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readDenylist } from '../src/denylist.js';

const A = 'Q' + 'Ab'.repeat(64);
const B = 'Q' + 'cd'.repeat(64);

test('denylist: missing file denies nobody, edits are picked up', () => {
  assert.equal(readDenylist('').size, 0);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deny-')), 'denylist.json');
  assert.equal(readDenylist(file).size, 0);
  fs.writeFileSync(file, JSON.stringify({ wallets: [A] }));
  assert.ok(readDenylist(file).has('ab'.repeat(64)));
  fs.writeFileSync(file, JSON.stringify({ wallets: [A, B] }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.ok(readDenylist(file).has('cd'.repeat(64)));
});
