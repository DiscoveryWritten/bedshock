/**
 * Reading a server log, and the two things this must refuse to do.
 *
 * Both refusals are the same principle wearing different clothes: an absent answer is not a
 * negative one. A battery that did not finish measured nothing, and a probe that put something
 * on a screen has no verdict until somebody looks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog } from './catalog.ts';
import { diagnose } from './run.ts';
import { collect, versionFromLog } from './collect.ts';

const catalog = loadCatalog();
const opts = { version: '1.21.120', run: 'test', at: '2026-08-02T00:00:00Z' } as const;

const line = (id: string, verdict: string, payload = '{}') =>
  `[2026-08-02 00:00:00 INFO] [Scripting] BEDSHOCK RESULT ${id} ${verdict} ${payload}`;
const DONE = '[2026-08-02 00:00:00 INFO] [Scripting] BEDSHOCK DONE 3';

test('a result line becomes an observation', () => {
  const log = [
    line('item.max_durability.int16_ceiling', 'YES', '{"measurement":{"samples":[]},"evidence":"all faithful"}'),
    DONE,
  ].join('\n');
  const { observations } = collect(log, catalog, opts);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.capability, 'item.max_durability.int16_ceiling');
  assert.equal(observations[0]!.verdict, 'YES');
  assert.equal(observations[0]!.evidence, 'all faithful');
  assert.deepEqual(observations[0]!.measurement, { samples: [] });
  assert.equal(observations[0]!.version, '1.21.120');
});

/**
 * The important one. Recording a prefix of a run as a run is how a ledger acquires confident
 * negatives about capabilities nobody measured — the exact failure this project exists to
 * prevent, arriving through the back door.
 */
test('a log with no DONE line records nothing at all', () => {
  const log = line('item.max_durability.int16_ceiling', 'YES');
  const result = collect(log, catalog, opts);
  assert.equal(result.complete, false);
  assert.equal(result.observations.length, 0);
  assert.match(result.problems.join('\n'), /did not finish/);
});

test('LOOK lines are surfaced but never recorded', () => {
  const log = [
    '[Scripting] BEDSHOCK LOOK item.name.glyph_renders_in_colour four rings in chat',
    DONE,
  ].join('\n');
  const result = collect(log, catalog, opts);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.looks, ['item.name.glyph_renders_in_colour']);
});

/**
 * A defence in depth against the same thing. Even if the runtime were changed to emit a
 * verdict for an eyes-only row, taking it at face value would be recording a guess as a
 * measurement.
 */
test('a RESULT for an observed capability is dropped, loudly', () => {
  const log = [line('item.name.glyph_renders_in_colour', 'YES'), DONE].join('\n');
  const result = collect(log, catalog, opts);
  assert.deepEqual(result.observations, []);
  assert.match(result.problems.join('\n'), /must go through `bedshock amend`/);
});

test('skips are surfaced with their reason', () => {
  const log = [
    '[Scripting] BEDSHOCK SKIP equipment.offhand.script_placed_item_persists no player connected (headless run)',
    DONE,
  ].join('\n');
  const result = collect(log, catalog, opts);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.why, /no player connected/);
});

test('an id the catalog does not declare is dropped and named', () => {
  const log = [line('item.made.up.entirely', 'YES'), DONE].join('\n');
  const result = collect(log, catalog, opts);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.unknown, ['item.made.up.entirely']);
});

test('one capability reported twice in a run is a probe bug, not two findings', () => {
  const log = [
    line('item.max_durability.int16_ceiling', 'YES'),
    line('item.max_durability.int16_ceiling', 'NO'),
    DONE,
  ].join('\n');
  const result = collect(log, catalog, opts);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]!.verdict, 'YES');
  assert.match(result.problems.join('\n'), /more than once/);
});

test('a probe that threw is reported rather than swallowed', () => {
  const log = ['[Scripting] BEDSHOCK ERROR container LocationInUnloadedChunkError', DONE].join('\n');
  const result = collect(log, catalog, opts);
  assert.match(result.problems.join('\n'), /container.*threw.*LocationInUnloadedChunkError/);
});

test('a malformed payload still records the verdict', () => {
  const log = [line('item.max_durability.int16_ceiling', 'YES', '{not json'), DONE].join('\n');
  const result = collect(log, catalog, opts);
  assert.equal(result.observations.length, 1);
  assert.match(result.problems.join('\n'), /not JSON/);
});

test('the server version is read out of its own log', () => {
  assert.equal(versionFromLog('[2026-08-02 INFO] Version: 1.21.120.03'), '1.21.120.03');
  assert.equal(versionFromLog('nothing here'), undefined);
});

// ---------------------------------------------------------------------------
// Rows that vanished
// ---------------------------------------------------------------------------

/**
 * ABSENCE IS THE ONE OUTPUT THAT HIDES, and this is the test that stops it hiding again.
 *
 * A row reporting INCONCLUSIVE is in the summary and obviously wants attention. A row that never
 * reports at all is simply not in the list — and the list looks exactly as healthy as it did the
 * run before. That happened: a measured probe overran the completion wait, the observation count
 * went from twelve to eleven, and nothing anywhere said which row or that anything was wrong.
 *
 * The battery already knew. `done()` names the probes that never came back. This is the collector
 * carrying that into the summary instead of leaving it to die in the log.
 */
test('a probe that registered for the wait and never reported is a loud problem', () => {
  const catalog = loadCatalog();
  const log = [
    'BEDSHOCK RESULT item.max_durability.int16_ceiling YES {}',
    'BEDSHOCK NOTE 1 probe(s) never reported back: knockback. Those rows are ABSENT, not negative.',
    'BEDSHOCK DONE 2',
  ].join('\n');

  const result = collect(log, catalog, { version: '1.26.30', run: 'test' });
  assert.equal(result.observations.length, 1, 'the rows that DID report are still recorded');
  const problem = result.problems.find((p) => p.includes('knockback'));
  assert.ok(problem, 'the vanished probe is not mentioned anywhere');
  assert.match(problem!, /ABSENT/);
  assert.match(problem!, /not negative/);
});

/**
 * A facility that could not be raised is not a measurement, and must not become one — but it is
 * also not nothing. Every reading taken inside a facility that did not build is a reading about
 * the rig, so it surfaces as a problem with the run rather than sitting in the log unread.
 */
test('a chapter that could not be built is a problem, never an observation', () => {
  const catalog = loadCatalog();
  const log = [
    'BEDSHOCK RESULT item.max_durability.int16_ceiling YES {}',
    'BEDSHOCK BUILD-FAILED physics step 2/4 "the edge": expected minecraft:polished_andesite at 28,-1,28 and found air',
    'BEDSHOCK DONE 1',
  ].join('\n');

  const result = collect(log, catalog, { version: '1.26.30', run: 'test' });
  assert.equal(result.observations.length, 1, 'the rows that did report are still recorded');
  const problem = result.problems.find((p) => p.includes('physics'));
  assert.ok(problem, 'a facility that failed to build is not mentioned anywhere');
  assert.match(problem!, /could not be built/);
  assert.match(problem!, /would be about Bedrock/);
  // It is apparatus, not a capability: nothing about it may reach the ledger as a verdict.
  assert.ok(!result.observations.some((o) => o.capability.includes('physics')));
});

test('several failed facilities are each named', () => {
  const catalog = loadCatalog();
  const log = [
    'BEDSHOCK BUILD-FAILED items step 1/3 "the floor": could not place',
    'BEDSHOCK BUILD-FAILED screens step 1/3 "the floor": could not place',
    'BEDSHOCK DONE 0',
  ].join('\n');
  const problems = collect(log, catalog, { version: '1.26.30', run: 'test' }).problems;
  assert.ok(problems.some((p) => p.includes('"items"')));
  assert.ok(problems.some((p) => p.includes('"screens"')));
});

test('a clean run reports no absences', () => {
  const catalog = loadCatalog();
  const log = 'BEDSHOCK RESULT item.max_durability.int16_ceiling YES {}\nBEDSHOCK DONE 1';
  assert.deepEqual(collect(log, catalog, { version: '1.26.30', run: 'test' }).problems, []);
});

// ---------------------------------------------------------------------------
// Diagnosing a run that never reported
// ---------------------------------------------------------------------------

/**
 * The error handler is allowed to guess. It is not allowed to guess when the log already says.
 *
 * This message used to be one confident hypothesis — "the likeliest cause is the whole behavior
 * pack being rejected over a script module pin" — printed whatever the log contained. The first
 * time it was wrong the log read `Port [19132] may be in use` two lines above, and the blame
 * landed on a manifest that was fine. A confident answer to a question nobody measured is the
 * exact failure this project exists to prevent; it does not get an exemption for being in an
 * error path.
 */
test('a run that failed for a reason the log states is not blamed on the module pin', () => {
  const port = diagnose('[ERROR] Port [19132] may be in use by another process\n[ERROR] Exiting program\n');
  assert.match(port, /could not bind its port/);
  assert.ok(!/module pin/.test(port), 'the log named the cause and the tool guessed anyway');

  const modules = diagnose('[ERROR] Failed to load script module @minecraft/server\n');
  assert.match(modules, /script module pin was rejected/);
});

test('with nothing recognisable in the log, the guess is offered as a guess', () => {
  const blind = diagnose('[INFO] Server started.\n');
  assert.match(blind, /read it rather than trusting a guess/);
  assert.match(blind, /usual culprit/);
});

test('every diagnosis says the run recorded nothing, because that is the part that matters', () => {
  for (const log of ['Port [19132] may be in use', 'Failed to load script module', '', 'nothing familiar']) {
    assert.match(diagnose(log), /measured nothing/);
  }
});
