/**
 * The search core.
 *
 * Tested here rather than in the pack because `pack/scripts/bisect.ts` imports nothing — that is
 * the property that makes it reusable outside Minecraft, and these tests are what keeps it true.
 * If somebody adds an `@minecraft/server` import to it, this file stops running.
 *
 * WHAT IS ACTUALLY AT STAKE. A bisection always converges on something. Point one at a trial
 * that never holds and it will hand back the bottom of the range with the same confidence it
 * hands back a real boundary, and the number goes into the ledger looking exactly like a
 * measurement. Every test below is one flavour of that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bisect, trialBudget, type Move, type SearchSpec } from '../pack/scripts/bisect.ts';

/**
 * Drive a search to completion against a step function: holds above (or below) `boundary`.
 * Returns the answer and every value that was tried.
 */
function drive(spec: SearchSpec, holds: (x: number) => boolean): { answer: Extract<Move, { done: true }>; asked: number[] } {
  const search = bisect(spec);
  const asked: number[] = [];
  let move = search.begin();
  let guard = 0;
  while (!move.done) {
    if (guard++ > 500) throw new Error('the search never terminated');
    asked.push(move.x);
    move = search.record(holds(move.x));
  }
  return { answer: move, asked };
}

const MIN: SearchSpec = { from: 0, to: 8, tolerance: 0.25, direction: 'minimum' };

// ---------------------------------------------------------------------------
// It finds the boundary
// ---------------------------------------------------------------------------

test('a minimum search converges on the smallest value that holds', () => {
  const { answer } = drive(MIN, (x) => x >= 2.7);
  assert.equal(answer.verdict, 'YES');
  assert.ok(Math.abs(answer.value! - 2.7) <= MIN.tolerance, `landed on ${answer.value}`);
  // The reported value must be one that HELD, never one that failed. A design tuned to the
  // reported number has to work at the reported number.
  assert.ok(answer.value! >= 2.7);
});

test('a maximum search converges on the largest value that holds', () => {
  const spec: SearchSpec = { from: 0, to: 20, tolerance: 0.1, direction: 'maximum' };
  const { answer } = drive(spec, (x) => x <= 6.25);
  assert.equal(answer.verdict, 'YES');
  assert.ok(Math.abs(answer.value! - 6.25) <= spec.tolerance, `landed on ${answer.value}`);
  assert.ok(answer.value! <= 6.25, 'reported a value the trial did not hold at');
});

test('the bracket brackets the answer', () => {
  const { answer } = drive(MIN, (x) => x >= 2.7);
  assert.ok(answer.bracket[0] <= 2.7 && answer.bracket[1] >= 2.7, `2.7 is not inside ${answer.bracket}`);
});

test('halving, not scanning — a wide range with a fine tolerance still costs a handful of trials', () => {
  const spec: SearchSpec = { from: 0, to: 1000, tolerance: 0.01, direction: 'minimum' };
  const { answer } = drive(spec, (x) => x >= 137);
  assert.equal(answer.verdict, 'YES');
  assert.ok(answer.trials <= trialBudget(spec), `${answer.trials} trials exceeds the stated budget`);
  assert.ok(answer.trials < 30);
});

// ---------------------------------------------------------------------------
// The three ways a search lies
// ---------------------------------------------------------------------------

/**
 * The failure this whole module is built around. A trial that is simply broken — the entity
 * never spawns, the chunk is not loaded — fails everywhere, and a naive bisection converges on
 * `from` and reports it as the tightest clearance Bedrock allows.
 */
test('a trial that never holds is INCONCLUSIVE, not a value at the bound', () => {
  const { answer } = drive(MIN, () => false);
  assert.equal(answer.verdict, 'INCONCLUSIVE');
  assert.equal(answer.value, undefined, 'an INCONCLUSIVE answer must carry no value at all');
  assert.match(answer.why, /did not hold even at/);
});

test('a trial that always holds is INCONCLUSIVE, because the boundary is outside the range', () => {
  const { answer } = drive(MIN, () => true);
  assert.equal(answer.verdict, 'INCONCLUSIVE');
  assert.equal(answer.value, undefined);
  assert.match(answer.why, /held even at/);
});

/**
 * Both bounds behave and the answer still is not one: the boundary sits within a tolerance of
 * the loose end, so widening the search would move it. A number that moves when you change the
 * question is not a measurement of the game.
 */
test('converging on the loose end of the range is refused rather than reported', () => {
  const { answer } = drive(MIN, (x) => x >= 7.95);
  assert.equal(answer.verdict, 'INCONCLUSIVE');
  assert.match(answer.why, /loose end/);
  assert.match(answer.why, /widen/);
});

test('but a boundary comfortably inside the range is fine, however near the tight end', () => {
  const { answer } = drive(MIN, (x) => x >= 0.4);
  assert.equal(answer.verdict, 'YES');
  assert.ok(answer.value! >= 0.4);
});

// ---------------------------------------------------------------------------
// Specs that cannot be searched
// ---------------------------------------------------------------------------

test('an unsearchable spec answers rather than throwing, so the row is still emitted', () => {
  for (const [spec, why] of [
    [{ from: 5, to: 5, tolerance: 1, direction: 'minimum' }, /range is empty/],
    [{ from: 0, to: 5, tolerance: 0, direction: 'minimum' }, /tolerance must be above zero/],
    [{ from: 0, to: 5, tolerance: 9, direction: 'minimum' }, /as wide as the search range/],
  ] as [SearchSpec, RegExp][]) {
    const move = bisect(spec).begin();
    assert.ok(move.done, 'an unsearchable spec must not ask for a trial');
    assert.equal(move.verdict, 'INCONCLUSIVE');
    assert.match(move.why, why);
  }
});

test('an answered search stays answered however many times it is recorded into', () => {
  const search = bisect({ from: 0, to: 0, tolerance: 1, direction: 'minimum' });
  const first = search.begin();
  assert.ok(first.done);
  assert.deepEqual(search.record(true), first);
  assert.deepEqual(search.record(false), first);
});

// ---------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------

/**
 * `repeats` is conjunctive: hold every time or you did not hold. The question a solve asks is
 * almost always "does this work RELIABLY at x", and one flake at a tight clearance is a design
 * that fails in play and passes in the battery.
 */
test('a flaky trial does not count as holding', () => {
  const spec: SearchSpec = { ...MIN, repeats: 3 };
  let flakes = 0;
  const { answer } = drive(spec, (x) => {
    if (x >= 2.7) return true;
    // Holds two times in three anywhere above 1, which without repeats would pull the boundary
    // down to 1 about four times in nine.
    if (x >= 1) return flakes++ % 3 !== 0;
    return false;
  });
  assert.equal(answer.verdict, 'YES');
  assert.ok(answer.value! >= 2.7, `a flaky trial dragged the boundary to ${answer.value}`);
});

test('a failure short-circuits the remaining repeats', () => {
  const spec: SearchSpec = { from: 0, to: 8, tolerance: 0.25, direction: 'minimum', repeats: 4 };
  const solid = drive(spec, (x) => x >= 2.7);
  // Every failing value costs one trial instead of four, so the real cost is well under budget.
  assert.ok(solid.answer.trials < trialBudget(spec));
});

test('repeats are asked at the same value, not at drifting ones', () => {
  const search = bisect({ from: 0, to: 8, tolerance: 0.25, direction: 'minimum', repeats: 3 });
  let move = search.begin();
  assert.ok(!move.done);
  const first = move.x;
  for (let i = 0; i < 2; i++) {
    move = search.record(true);
    assert.ok(!move.done);
    assert.equal(move.x, first, 'a repeat moved to a different value');
  }
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * A trial that disagrees with itself never narrows the bracket. Without a ceiling the search
 * runs forever; with one that reports a value, it hands back whichever half it happened to be
 * in. A half-narrowed bracket is a range, and recording a range as a solve files a number
 * nothing measured.
 */
test('running out of trials reports the bracket and no value', () => {
  let flip = false;
  const { answer } = drive({ from: 0, to: 8, tolerance: 0.001, direction: 'minimum', maxTrials: 12 }, (x) => {
    if (x >= 8) return true;
    if (x <= 0) return false;
    flip = !flip;
    return flip;
  });
  assert.equal(answer.verdict, 'INCONCLUSIVE');
  assert.equal(answer.value, undefined);
  assert.match(answer.why, /ran out of trials/);
  assert.ok(answer.bracket[1] > answer.bracket[0]);
});

test('the budget is an upper bound on a well-behaved trial', () => {
  for (const tolerance of [0.5, 0.1, 0.01]) {
    const spec: SearchSpec = { from: 0, to: 64, tolerance, direction: 'minimum', repeats: 2 };
    const { answer } = drive(spec, (x) => x >= 21.3);
    assert.equal(answer.verdict, 'YES');
    assert.ok(answer.trials <= trialBudget(spec), `tolerance ${tolerance}: ${answer.trials} > ${trialBudget(spec)}`);
  }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('the history is every trial in order, which is what makes a bad solve diagnosable', () => {
  const search = bisect(MIN);
  let move = search.begin();
  const asked: number[] = [];
  while (!move.done) {
    asked.push(move.x);
    move = search.record(move.x >= 2.7);
  }
  assert.deepEqual(search.history().map((h) => h.x), asked);
  assert.equal(search.history().length, move.trials);
  // The bounds are confirmed first, and in that order — the check that makes the other two
  // failure modes detectable at all.
  assert.equal(asked[0], MIN.to);
  assert.equal(asked[1], MIN.from);
});
