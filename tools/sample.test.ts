/**
 * The aggregation core, and the rule that says an apparatus is precise enough to be worth running.
 *
 * Tested here rather than in the pack because `pack/scripts/sample.ts` imports nothing — the same
 * property that lets somebody use it for an in-memory measurement outside Minecraft. If an
 * `@minecraft/server` import appears in it, this file stops running.
 *
 * WHAT IS AT STAKE. A mean always exists. Hand one five readings from a rig that worked twice and
 * it produces a number with as many decimal places as a good one, and that number goes into the
 * ledger looking exactly like a measurement. Every test below is a flavour of that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { median, medianScatter, summarise, type SampleSpec } from '../pack/scripts/sample.ts';
import { loadCatalog } from './catalog.ts';
import { loadPackConfig } from './config.ts';

const SPEC: SampleSpec = { samples: 5, spread: 0.5, range: { from: 0, to: 24 } };

// ---------------------------------------------------------------------------
// It produces a number
// ---------------------------------------------------------------------------

test('readings that agree produce their median', () => {
  const s = summarise([4.1, 4.2, 4.0, 4.15, 4.05], SPEC);
  assert.equal(s.verdict, 'YES');
  assert.equal(s.value, 4.1);
  assert.equal(s.kept.length, 5);
});

/** One reading down a ravine must not move the answer, which is why it is not a mean. */
test('the median ignores an outlier that a mean would let through', () => {
  const spread: SampleSpec = { ...SPEC, spread: 100 };
  assert.equal(summarise([4, 4, 4, 4, 23], spread).value, 4);
  // The mean of those is 7.8 — nearly double, from one bad reading in five.
  assert.notEqual(summarise([4, 4, 4, 4, 23], spread).value, 7.8);
});

test('an even count averages the two middle readings', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 4, 2]), 2.5, 'the readings must be sorted before the middle is taken');
  assert.equal(median([7]), 7);
  assert.ok(Number.isNaN(median([])));
});

// ---------------------------------------------------------------------------
// Or refuses to
// ---------------------------------------------------------------------------

/**
 * The refusal this module exists for. Both of these sets have five readings and a perfectly
 * computable middle; only one of them is a measurement.
 */
test('readings that disagree past the allowed scatter are INCONCLUSIVE, not averaged', () => {
  const s = summarise([2, 4, 6, 8, 10], SPEC);
  assert.equal(s.verdict, 'INCONCLUSIVE');
  assert.equal(s.value, undefined, 'an INCONCLUSIVE summary must carry no value at all');
  assert.match(s.why, /scatter/);
  assert.match(s.why, /drift against itself/);
});

test('a rig that mostly failed does not get to speak for the readings that worked', () => {
  const s = summarise([null, null, null, 4.1, 4.1], SPEC);
  assert.equal(s.verdict, 'INCONCLUSIVE');
  assert.equal(s.value, undefined);
  assert.match(s.why, /only 2 of 5/);
  assert.match(s.why, /3 reading\(s\) failed/);
});

/**
 * The refusal has to carry the diagnosis, and this is why.
 *
 * A real run lost all five knockback readings. The summary said `5 reading(s) failed outright`
 * and that was the entire diagnosis available from the log — the probe had explained itself five
 * times and every one of those sentences was discarded here. Re-learning something the apparatus
 * already knew cost a whole server run.
 */
test('a refusal carries what the apparatus said, deduplicated', () => {
  const s = summarise(
    [null, null, null, null, null],
    { samples: 5, spread: 0.2 },
    ['it never moved', 'it never moved', 'it never moved', 'the arena had no floor', 'it never moved'],
  );
  assert.equal(s.verdict, 'INCONCLUSIVE');
  assert.match(s.why, /The apparatus said:/);
  assert.match(s.why, /it never moved/);
  assert.match(s.why, /the arena had no floor/);
  // Five identical failures are one fact. A wall of repeated text is how a diagnosis gets skimmed.
  assert.equal(s.why.match(/it never moved/g)!.length, 1);
});

test('only the failed readings explain themselves, not the ones that worked', () => {
  const s = summarise([4, null, null, null, 4.1], { samples: 5, spread: 0.5 }, ['fine', 'broke', 'broke', 'broke', 'fine']);
  assert.match(s.why, /broke/);
  assert.ok(!s.why.includes('fine'), 'a successful reading has nothing to explain');
});

test('notes are optional, and a summary without them still reads', () => {
  const s = summarise([null, null, null, 4, 4], { samples: 5, spread: 0.5 });
  assert.equal(s.verdict, 'INCONCLUSIVE');
  assert.ok(!s.why.includes('The apparatus said'));
});

test('exactly half surviving is not a majority', () => {
  const four: SampleSpec = { ...SPEC, samples: 4 };
  assert.equal(summarise([null, null, 4, 4], four).verdict, 'INCONCLUSIVE');
  assert.equal(summarise([null, 4, 4, 4], four).verdict, 'YES');
});

/**
 * A reading outside the plausible range did not measure the thing. Averaging it in would let a
 * thrown item that fell down a ravine set the throw distance.
 */
test('a reading outside the plausible range is discarded rather than averaged in', () => {
  const s = summarise([4, 4.1, 900, 4.2, 4.1], SPEC);
  assert.equal(s.verdict, 'YES');
  assert.equal(s.rejected, 1);
  assert.ok(!s.kept.includes(900));
  assert.match(s.why, /1 out of range/, 'a discarded reading must still be visible in the evidence');
});

test('mostly-out-of-range is the same failure as mostly-failed', () => {
  const s = summarise([900, 900, 900, 4, 4.1], SPEC);
  assert.equal(s.verdict, 'INCONCLUSIVE');
  assert.match(s.why, /outside the plausible range/);
});

test('non-finite readings are failures, not values', () => {
  const s = summarise([NaN, Infinity, 4, 4.1, 4.05], SPEC);
  assert.equal(s.verdict, 'YES');
  assert.equal(s.failed, 2);
  assert.equal(s.kept.length, 3);
});

/** Zero is a perfectly good reading and must never be confused with a reading that failed. */
test('zero is a value, and null is not', () => {
  const zeroes: SampleSpec = { samples: 3, spread: 0.5 };
  const s = summarise([0, 0, 0], zeroes);
  assert.equal(s.verdict, 'YES');
  assert.equal(s.value, 0);
  assert.equal(s.failed, 0);
});

test('the observed scatter is reported even when it passes, so a reader can see the margin', () => {
  const s = summarise([4, 4.3, 4.1], { samples: 3, spread: 0.5 });
  assert.equal(s.verdict, 'YES');
  assert.ok(Math.abs(s.observed - 0.3) < 1e-9);
  assert.match(s.why, /allowed 0\.5/);
});

// ---------------------------------------------------------------------------
// Enough samples to be worth recording
// ---------------------------------------------------------------------------

test('scatter averages down with the square root of the sample count', () => {
  assert.ok(Math.abs(medianScatter({ samples: 4, spread: 1 }) - 0.5) < 1e-9);
  assert.ok(medianScatter({ samples: 16, spread: 1 }) < medianScatter({ samples: 4, spread: 1 }));
  assert.equal(medianScatter({ samples: 0, spread: 1 }), Infinity);
});

/**
 * THE RULE THAT MAKES A MEASURED ROW WORTH HAVING, checked rather than hoped for.
 *
 * An apparatus is allowed to be noisier than its capability's tolerance — readings scatter, and
 * demanding otherwise would rule out every physics probe. What it is NOT allowed to do is be
 * noisier than the tolerance AND take too few samples to average down below it, because then the
 * recorded value moves further than the tolerance between runs on nothing but noise. That row
 * reports DRIFT every time it is measured, forever, and a drift report people learn to ignore is
 * worse than no drift report at all.
 *
 * The two halves of this live in two files that cannot see each other — the tolerance is the
 * question's, the scatter and sample count are the instrument's — so nothing but a cross-check
 * can catch it.
 */
test('every measured probe takes enough samples for its scatter to fit inside the tolerance', () => {
  const catalog = loadCatalog();
  const config = loadPackConfig();
  const measured: [string, string][] = [
    ['throw', 'physics.throw.item_travel_distance'],
    ['knockback', 'physics.knockback.blocks_per_unit'],
    ['knockback', 'physics.knockback.blocks_per_unit_on_an_entity'],
  ];

  for (const [probe, id] of measured) {
    const cap = catalog.byId.get(id);
    assert.ok(cap, `${id} is not in the catalog`);
    assert.equal(cap!.probe, probe, `${id} is not answered by the ${probe} probe`);
    const apparatus = config.probes[probe as 'throw' | 'knockback'];
    const scatter = medianScatter({ samples: apparatus.samples, spread: apparatus.spread });
    assert.ok(
      scatter <= cap!.measures!.tolerance,
      `${id}: readings scatter ${apparatus.spread} over ${apparatus.samples} samples, so the ` +
        `median moves about ${scatter.toFixed(3)} — past the tolerance of ${cap!.measures!.tolerance}. ` +
        `Take more samples, or tighten the apparatus.`,
    );
  }
});
