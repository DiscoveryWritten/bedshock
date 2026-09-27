import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cellsFor32, digits, hash32, pack, sequence, size, undigits, unpack } from '../pack/scripts/codec.ts';

const small = { states: 1, values: 16 };
const dense = { states: 6, values: 16 };
const odd = { states: 3, values: 7 };

test('a symbol and its per-state values are the same thing', () => {
  for (const a of [small, dense, odd]) {
    for (const n of [0, 1, size(a) - 1, Math.floor(size(a) / 3)]) {
      assert.equal(undigits(a, digits(a, n)), n, `${a.states}x${a.values} at ${n}`);
    }
  }
});

test('a state value out of range, missing, or not an integer is corruption, not a symbol', () => {
  assert.equal(undigits(odd, [0, 7, 0]), undefined);
  assert.equal(undigits(odd, [0, undefined, 0]), undefined);
  assert.equal(undigits(odd, [0, 1.5, 0]), undefined);
});

test('a 32-bit number packs into the fewest symbols that hold it, and back', () => {
  assert.equal(cellsFor32(small), 8);
  assert.equal(cellsFor32(dense), 2);
  for (const a of [small, dense, odd]) {
    for (const n of [0, 1, 0xdeadbeef, 0xffffffff]) assert.equal(unpack(a, pack(a, n)), n);
  }
  assert.equal(unpack(dense, [1, undefined]), undefined);
});

test('the same seed always gives the same run, and a different seed a different one', () => {
  assert.deepEqual(sequence(dense, 42, 100), sequence(dense, 42, 100));
  assert.notDeepEqual(sequence(dense, 42, 100), sequence(dense, 43, 100));
  assert.ok(sequence(odd, 7, 1000).every((s) => s >= 0 && s < size(odd) && Number.isInteger(s)));
});

test('hash32 is stable', () => {
  assert.equal(hash32(''), 0x811c9dc5);
  assert.equal(hash32('bedshock'), hash32('bedshock'));
  assert.notEqual(hash32('s1'), hash32('s2'));
});
