/**
 * Build orders, checked before anything is placed.
 *
 * `pack/scripts/blueprint.ts` imports nothing, so a facility's plan can be argued with on a
 * machine that has no Minecraft on it. That matters more here than for the other pure modules:
 * a bad blueprint does not throw, it builds a facility that is subtly wrong, and every
 * measurement taken against it comes out plausible.
 *
 * THE FAILURE THIS FILE IS REALLY ABOUT is a later step silently replacing an earlier one. It is
 * the same shape as two probes sweeping each other's arenas — which cost three readings in five
 * and read exactly like a despawn — except that this time it is catchable in data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  at, column, fill, footprint, overwrites, rim, slab, validate, type Blueprint,
} from '../pack/scripts/blueprint.ts';
import { CHAPTERS } from '../pack/scripts/chapters.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

test('a slab is flat and covers its whole span', () => {
  const places = slab([0, 2], [0, 1], -1, 'minecraft:stone');
  assert.equal(places.length, 3 * 2);
  assert.ok(places.every((p) => p.u === -1));
  assert.equal(new Set(places.map((p) => `${p.f},${p.s}`)).size, 6);
});

test('a span given backwards still fills the same box', () => {
  assert.deepEqual(slab([2, 0], [1, 0], 0, 'minecraft:stone').length, slab([0, 2], [0, 1], 0, 'minecraft:stone').length);
});

test('a column is one cell wide and as tall as asked', () => {
  const places = column(3, -1, [0, 4], 'minecraft:anvil');
  assert.equal(places.length, 5);
  assert.equal(new Set(places.map((p) => `${p.f},${p.s}`)).size, 1);
});

/** A rim is a ring, not a filled box — or every floor under it would read as an overwrite. */
test('a rim is hollow', () => {
  const ring = rim([0, 3], [0, 3], 0, 'minecraft:stone');
  assert.equal(ring.length, 4 * 4 - 2 * 2, 'the rim filled its interior');
  assert.ok(!ring.some((p) => p.f === 1 && p.s === 1));
});

test('a footprint is the box everything sits in, and counts distinct cells', () => {
  const blueprint: Blueprint = {
    name: 'x',
    steps: [
      { name: 'floor', places: slab([-2, 2], [-2, 2], -1, 'minecraft:stone') },
      { name: 'post', places: column(0, 0, [0, 3], 'minecraft:stone') },
    ],
  };
  const box = footprint(blueprint);
  assert.deepEqual(box.from, { f: -2, u: -1, s: -2 });
  assert.deepEqual(box.to, { f: 2, u: 3, s: 2 });
  assert.equal(box.size, 25 + 4);
});

// ---------------------------------------------------------------------------
// The one property a build order must have
// ---------------------------------------------------------------------------

test('a later step writing over an earlier one is reported, with both step names', () => {
  const blueprint: Blueprint = {
    name: 'clash',
    steps: [
      { name: 'floor', places: at(0, 0, 0, 'minecraft:stone') },
      { name: 'lantern', places: at(0, 0, 0, 'minecraft:sea_lantern') },
    ],
  };
  const found = overwrites(blueprint);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.by, ['floor', 'lantern']);
  assert.deepEqual(found[0]!.blocks, ['minecraft:stone', 'minecraft:sea_lantern']);
  assert.match(validate(blueprint).join('\n'), /floor then lantern/);
  assert.match(validate(blueprint).join('\n'), /invisible in play/);
});

/** Overwriting on purpose is fine. Overwriting by accident is the bug, and the difference is saying so. */
test('a declared overwrite is not a problem', () => {
  const blueprint: Blueprint = {
    name: 'deliberate',
    steps: [
      { name: 'floor', places: at(0, 0, 0, 'minecraft:stone') },
      { name: 'lantern', places: at(0, 0, 0, 'minecraft:sea_lantern'), mayOverwrite: [{ f: 0, u: 0, s: 0 }] },
    ],
  };
  assert.deepEqual(overwrites(blueprint), []);
  assert.deepEqual(validate(blueprint), []);
});

test('one step writing the same cell twice is still one step, and not a clash', () => {
  const blueprint: Blueprint = {
    name: 'self',
    steps: [{ name: 'floor', places: [...at(0, 0, 0, 'minecraft:stone'), ...at(0, 0, 0, 'minecraft:stone')] }],
  };
  // Two placements, one step: the second is redundant rather than a build-order error, so it is
  // not reported as one. `by` would name a single step and there is nothing to reorder.
  assert.equal(overwrites(blueprint).length, 1);
  assert.deepEqual(overwrites(blueprint)[0]!.by, ['floor', 'floor']);
});

// ---------------------------------------------------------------------------
// Blueprints that could not be reported on
// ---------------------------------------------------------------------------

test('a step that places nothing, or shares a name, is refused', () => {
  assert.match(
    validate({ name: 'empty', steps: [{ name: 'floor', places: [] }] }).join('\n'),
    /places nothing/,
  );
  assert.match(
    validate({
      name: 'twins',
      steps: [
        { name: 'floor', places: at(0, 0, 0, 'minecraft:stone') },
        { name: 'floor', places: at(1, 0, 0, 'minecraft:stone') },
      ],
    }).join('\n'),
    /share a name/,
  );
  assert.match(validate({ name: 'none', steps: [] }).join('\n'), /no steps/);
});

test('an unnamespaced block id is refused, because it is the typo that builds nothing', () => {
  assert.match(
    validate({ name: 'bare', steps: [{ name: 'floor', places: at(0, 0, 0, 'stone') }] }).join('\n'),
    /not a namespaced block id/,
  );
});

// ---------------------------------------------------------------------------
// The shipped chapters
// ---------------------------------------------------------------------------

/**
 * THE FACILITY IS BUILT FRESH EVERY RUN, so its plan is checked every run too — but a plan that
 * only fails in-game costs a session to find out about. These are the same checks the runtime
 * makes before placing anything, run here so a bad blueprint never reaches a tablet.
 */
test('every shipped chapter has a buildable blueprint', () => {
  assert.ok(CHAPTERS.length > 0);
  for (const chapter of CHAPTERS) {
    assert.deepEqual(validate(chapter.blueprint), [], `chapter "${chapter.name}"`);
  }
});

test('every chapter names at least one probe, and no probe is in two chapters', () => {
  const seen = new Map<string, string>();
  for (const chapter of CHAPTERS) {
    assert.ok(chapter.probes.length > 0, `chapter "${chapter.name}" runs nothing`);
    assert.ok(chapter.about, `chapter "${chapter.name}" says nothing about itself`);
    for (const probe of chapter.probes) {
      const already = seen.get(probe);
      // A probe in two chapters would run twice against two facilities, and the ledger would get
      // two observations from one session that look like independent confirmation.
      assert.equal(already, undefined, `probe "${probe}" is in both "${already}" and "${chapter.name}"`);
      seen.set(probe, chapter.name);
    }
  }
});

/**
 * A chapter that stands somebody somewhere has to stand them ON something. Two hundred blocks up
 * there is nothing to catch a fall, so a viewpoint over air is a chapter that begins by killing
 * the person running it.
 */
test('every viewpoint has floor under it', () => {
  for (const chapter of CHAPTERS) {
    const view = chapter.viewFrom;
    if (!view) continue;
    const placed = new Set(
      chapter.blueprint.steps.flatMap((s) => s.places).map((p) => `${p.f},${p.u},${p.s}`),
    );
    assert.ok(
      placed.has(`${view.f},${view.u - 1},${view.s}`),
      `chapter "${chapter.name}" stands you at ${view.f},${view.u},${view.s} with nothing underneath`,
    );
  }
});

/** Chapters are torn down and rebuilt in one place, so their footprints have to be finite. */
test('no chapter builds something absurd', () => {
  for (const chapter of CHAPTERS) {
    const box = footprint(chapter.blueprint);
    assert.ok(box.size > 0, `chapter "${chapter.name}" builds nothing`);
    // A chunk is 16 wide; four chunks each way is already a lot to clear every rebuild.
    assert.ok(box.to.f - box.from.f <= 64, `chapter "${chapter.name}" is ${box.to.f - box.from.f} long`);
    assert.ok(box.to.s - box.from.s <= 64, `chapter "${chapter.name}" is ${box.to.s - box.from.s} wide`);
    assert.ok(box.to.u - box.from.u <= 64, `chapter "${chapter.name}" is ${box.to.u - box.from.u} tall`);
  }
});

test('fill is the shape everything else is made of', () => {
  const box = fill({ f: [0, 1], u: [0, 1], s: [0, 1] }, 'minecraft:stone');
  assert.equal(box.length, 8);
  assert.equal(new Set(box.map((p) => `${p.f},${p.u},${p.s}`)).size, 8);
});
