/**
 * The measured-quantity machinery: the scale glyph, and what counts as a solved row moving.
 *
 * Both exist for the same reason. A yes/no capability only reports when something appears or
 * disappears; a solved one reports when the game's constants shift under an implementation that
 * still runs and still passes. That is the change most likely to survive a release unnoticed,
 * and the least likely to be noticed by reading.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bar, decadeBounds, formatValue, legend, logPosition, scaleBlock } from './scale.ts';
import { loadCatalog } from './catalog.ts';
import { statusAt } from './ledger.ts';
import { buildManifest, diffManifests } from './manifest.ts';
import type { Capability, Observation } from './types.ts';

// ---------------------------------------------------------------------------
// The scale
// ---------------------------------------------------------------------------

/** A column of bars is only comparable if every bar is the same length. */
test('every bar is exactly the same width, whatever it contains', () => {
  const width = 20;
  const lengths = new Set(
    [0, -1, 0.0001, 0.5, 1, 42, 1e9, Infinity, NaN].map((v) => [...bar(v, { width })].length),
  );
  assert.deepEqual([...lengths], [width + 1]);
});

test('a decade is always the same distance along', () => {
  const at = (v: number) => logPosition(v, 0.01, 100);
  // 0.01 -> 0.1 -> 1 -> 10 -> 100 is four decades, so each is a quarter of the scale.
  const steps = [0.01, 0.1, 1, 10, 100].map(at);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(Math.abs(steps[i]! - steps[i - 1]! - 0.25) < 1e-9, `decade ${i} is not a quarter`);
  }
});

/**
 * Zero is a different fact from "very small", and a log scale has no zero. Collapsing them
 * would make a genuine nothing indistinguishable from a value below the resolution, which is
 * exactly the distinction a tolerance is set from.
 */
test('zero and out-of-range get their own glyphs rather than a position', () => {
  assert.ok(bar(0).startsWith('·'), 'zero must not look like a small value');
  assert.ok(bar(-5).startsWith('·'));
  assert.ok(bar(1e6, { min: 0.01, max: 100 }).includes('▸'), 'a pinned bar must not look like a reading');
  assert.ok(bar(1, { min: 0.01, max: 100 }).includes('●'));
});

test('bounds snap to whole decades, so two reports of one column share a scale', () => {
  assert.deepEqual(decadeBounds([0.0625, 0.33, 1.4, 28.5]), { min: 0.01, max: 100 });
  // Nudging one value inside the same decades must not move the scale.
  assert.deepEqual(decadeBounds([0.07, 0.4, 1.5, 29]), { min: 0.01, max: 100 });
  // A single value still gets a scale with width to it.
  const one = decadeBounds([5]);
  assert.ok(one.max > one.min);
});

test('a value is trimmed without inventing or losing precision', () => {
  assert.equal(formatValue(100), '100');
  assert.equal(formatValue(1000), '1000');
  assert.equal(formatValue(0.0625), '0.063');
  assert.equal(formatValue(28.5), '28.5');
  assert.equal(formatValue(1.4, 'blocks'), '1.4 blocks');
  assert.equal(formatValue(NaN), '—');
});

/** The bug that shipped: a blanket trailing-zero strip turned 100 into 1. */
test('trailing zeros are stripped only after a decimal point', () => {
  assert.equal(formatValue(10), '10');
  assert.equal(formatValue(200), '200');
  assert.match(legend(0.01, 100), /0\.01 to 100/);
});

test('a block of rows aligns on one column', () => {
  const lines = scaleBlock([
    { label: 'short', value: 0.0625, unit: 'blocks' },
    { label: 'a much longer label', value: 28.5, unit: 'blocks' },
  ]);
  const barStarts = lines.map((l) => l.indexOf('├'));
  assert.equal(new Set(barStarts).size, 1, 'the bars do not line up');
});

// ---------------------------------------------------------------------------
// Solved rows
// ---------------------------------------------------------------------------

const catalog = loadCatalog();
const solved = catalog.capabilities.find((c) => c.method === 'solved')!;
const V = '1.26.30';

const reading = (value: number, at: string, run: string): Observation => ({
  capability: solved.id,
  version: V,
  platform: 'bds',
  method: 'automated',
  verdict: 'YES',
  value,
  run,
  at,
});

test('the catalog actually declares solved rows, with a unit and a positive tolerance', () => {
  const all = catalog.capabilities.filter((c) => c.method === 'solved');
  assert.ok(all.length >= 3, 'a battery with no measured quantities cannot notice a constant moving');
  for (const cap of all) {
    assert.ok(cap.measures?.unit, `${cap.id} has no unit`);
    assert.ok((cap.measures?.tolerance ?? 0) > 0, `${cap.id} has no positive tolerance`);
    assert.ok(!cap.outcomes, `${cap.id} is solved and should have no outcomes`);
  }
});

/** Movement inside the tolerance is the apparatus, not the game. */
test('a solve that moves within tolerance is not drift', () => {
  const tolerance = solved.measures!.tolerance;
  const status = statusAt(solved, V, [
    reading(1, '2026-01-01T00:00:00Z', 'a'),
    reading(1 + tolerance * 0.5, '2026-02-01T00:00:00Z', 'b'),
  ]);
  assert.equal(status.status, 'SETTLED');
});

/**
 * The whole reason these rows exist. Both runs converged, both said YES, and the number moved —
 * which a verdict comparison would call agreement.
 */
test('a solve that moves beyond tolerance is DRIFT even though both runs said YES', () => {
  const tolerance = solved.measures!.tolerance;
  const status = statusAt(solved, V, [
    reading(1, '2026-01-01T00:00:00Z', 'a'),
    reading(1 + tolerance * 3, '2026-02-01T00:00:00Z', 'b'),
  ]);
  assert.equal(status.status, 'DRIFT');
  assert.match(status.conflict!, /the solve moved/);
});

test('a moved solve across versions is reported as its own kind of news', () => {
  const before = [reading(1, '2026-01-01T00:00:00Z', 'a')];
  const after = [{ ...reading(1 + solved.measures!.tolerance * 5, '2027-01-01T00:00:00Z', 'b'), version: '1.26.50' }];

  const diff = diffManifests(
    buildManifest(catalog, before, V),
    buildManifest(catalog, [...before, ...after], '1.26.50'),
  );
  const moved = diff.values_moved.find((r) => r.id === solved.id);
  assert.ok(moved, 'a value that moved beyond tolerance must appear in values_moved');
  assert.equal(moved!.unit, solved.measures!.unit);
  // Nothing appeared or disappeared, so it must NOT be reported as a status change.
  assert.equal(diff.became_possible.length, 0);
  assert.equal(diff.became_impossible.length, 0);
});

test('a value that held steady is not reported as moved', () => {
  const obs = [reading(1, '2026-01-01T00:00:00Z', 'a')];
  const diff = diffManifests(buildManifest(catalog, obs, V), buildManifest(catalog, obs, V));
  assert.deepEqual(diff.values_moved, []);
});

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * Every capability has to say what would have to change for its answer to change. A consumer
 * asking "will this still hold if I raise my script pin" gets a different answer for an `engine`
 * row than a `script` one, and guessing wrong is worse than not knowing.
 */
test('every capability declares a surface, and the battery covers all three', () => {
  const surfaces = new Set<string>();
  for (const cap of catalog.capabilities as Capability[]) {
    assert.ok(['engine', 'script', 'content'].includes(cap.surface), `${cap.id} has surface "${cap.surface}"`);
    surfaces.add(cap.surface);
  }
  assert.deepEqual([...surfaces].sort(), ['content', 'engine', 'script']);
});

test('the surface survives into the manifest, because a consumer cannot recover it otherwise', () => {
  const manifest = buildManifest(catalog, [], V);
  for (const row of manifest.capabilities) {
    assert.ok(row.surface, `${row.id} lost its surface`);
  }
});
