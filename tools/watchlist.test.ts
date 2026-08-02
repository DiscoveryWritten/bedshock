/**
 * The negative watchlist, and the manifest that carries it.
 *
 * A battery for a platform that changes under you is not mainly there to confirm what already
 * works. It is there so that the day something becomes possible, the test that proves it was
 * written months ago and runs without anybody deciding to look.
 *
 * That only works if a `NO` keeps getting asked. The first version of `probesFor` excluded
 * `CLOSED-NEGATIVE` from `--open`, so a negative was never re-asked by any narrowed sweep —
 * exactly backwards, and invisible until somebody went looking for why a sweep was cheap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog } from './catalog.ts';
import { loadPackConfig } from './config.ts';
import { readLedger, resolveWithDeps } from './ledger.ts';
import { probesFor, watchlist, matchesAsk, ALL_ASKS } from './run.ts';
import { buildManifest, catalogRevision, diffManifests } from './manifest.ts';
import type { Observation, Status } from './types.ts';

const catalog = loadCatalog();
const ledger = readLedger();
const V = '1.21.120';

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

test('each reason for asking matches the statuses it should, and no others', () => {
  const rows: [Status, Record<string, boolean>][] = [
    ['SETTLED', { open: false, negative: false, regress: true }],
    ['CLOSED-NEGATIVE', { open: false, negative: true, regress: false }],
    ['OPEN', { open: true, negative: false, regress: false }],
    // These three LOOK answered and are not, which is why `open` claims them.
    ['INCONCLUSIVE', { open: true, negative: false, regress: false }],
    ['DRIFT', { open: true, negative: false, regress: false }],
    ['UNDERMINED', { open: true, negative: false, regress: false }],
  ];
  for (const [status, expected] of rows) {
    for (const ask of ALL_ASKS) {
      assert.equal(matchesAsk(status, ask), expected[ask], `${status} / ${ask}`);
    }
  }
});

/** The bug this file exists for. A negative must be re-askable. */
test('a probe carrying a measured-NO row is selected by --negative', () => {
  const probes = probesFor(['negative'], V, catalog, ledger);
  assert.ok(probes.length > 0, 'nothing is on the negative watchlist — the regression is back');
  assert.ok(probes.includes('container'), 'the chest container row is measured NO and should be here');
  assert.ok(probes.includes('offhand'), 'the off-hand ejection row is measured NO and should be here');
});

test('--open and --negative are disjoint, and together cover everything not settled', () => {
  const open = new Set(probesFor(['open'], V, catalog, ledger));
  const negative = new Set(probesFor(['negative'], V, catalog, ledger));
  const both = new Set(probesFor(['open', 'negative'], V, catalog, ledger));
  for (const probe of [...open, ...negative]) assert.ok(both.has(probe), `${probe} missing from the union`);

  // Disjointness is at the CAPABILITY level, not the probe level — one probe can carry both an
  // open row and a negative one, which is why the sets of probes may overlap and the sets of
  // reasons may not.
  for (const cap of catalog.capabilities) {
    if (cap.method === 'derived') continue;
    const status = resolveWithDeps(cap, V, ledger, catalog).status;
    const matched = ALL_ASKS.filter((a) => matchesAsk(status, a));
    assert.equal(matched.length, 1, `${cap.id} is ${status} and matches ${matched.length} reasons`);
  }
});

test('asking for everything is no narrowing rather than no probes', () => {
  assert.deepEqual(probesFor([], V, catalog, ledger), []);
  assert.deepEqual(probesFor(ALL_ASKS, V, catalog, ledger), []);
});

// ---------------------------------------------------------------------------
// The watchlist itself
// ---------------------------------------------------------------------------

test('the watchlist is every row measured NO, with what flipping it would unblock', () => {
  const rows = watchlist(V, catalog, ledger);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(resolveWithDeps(catalog.byId.get(row.id)!, V, ledger, catalog).status, 'CLOSED-NEGATIVE');
    assert.ok(row.decides.length > 0, `${row.id} has nothing to unblock`);
    assert.ok(row.question.length > 0);
  }
});

/**
 * The property the whole project rests on, asserted rather than assumed.
 *
 * A battery whose every question comes back yes is not probing limits — it is confirming a happy
 * path. The interesting rows are the ones that failed, and if this ever drops to zero it means
 * either Bedrock grew everything we asked for (worth knowing) or somebody quietly removed the
 * questions that were inconvenient (worth stopping for).
 */
test('the suite genuinely asks things that come back NO', () => {
  const negatives = watchlist(V, catalog, ledger);
  assert.ok(
    negatives.length >= 3,
    `only ${negatives.length} row(s) are measured NO. A battery that only asks answerable questions ` +
      `is not probing limits — check whether questions were dropped rather than answered.`,
  );
});

/**
 * And the other kind of expected failure: samples INSIDE a probe that are supposed to fail.
 *
 * The durability ceilings above 32767 are declared expecting the game to mishandle them, and
 * that mishandling IS the measurement — it is how a wrap is told from a clamp. A ceiling list
 * with no above-boundary entry would measure only the comfortable half.
 */
test('at least one probe declares samples it expects the game to mishandle', () => {
  // Read through the public loader rather than the file, so this follows a config move.
  const ceilings = loadPackConfig().probes.durability.ceilings;
  assert.ok(
    ceilings.some((n) => n > 32767),
    'no durability ceiling is above the int16 boundary, so the probe cannot tell a wrap from a clamp',
  );
  assert.ok(
    ceilings.some((n) => n <= 32767),
    'every ceiling is above the boundary, so there is no working case to compare the failures against',
  );
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test('the manifest carries both halves of its identity', () => {
  const m = buildManifest(catalog, ledger, V);
  assert.equal(m.minecraft, V);
  assert.match(m.catalog_revision, /^r[0-9a-f]{8}$/);
  assert.equal(m.release, `mc-${V}-${m.catalog_revision}`);
  assert.equal(m.schema, 1);
});

/** A revision that did not move when the catalog did is a manifest a consumer caches wrongly. */
test('the catalog revision is stable across calls and derived from the catalog', () => {
  assert.equal(catalogRevision(), catalogRevision());
  assert.equal(buildManifest(catalog, ledger, V).catalog_revision, catalogRevision());
});

test('every capability appears in the manifest, derived rows included', () => {
  const m = buildManifest(catalog, ledger, V);
  assert.equal(m.capabilities.length, catalog.capabilities.length);
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, catalog.capabilities.length, 'the counts do not add up to the rows');
});

test('the manifest names the watchlist at the top level', () => {
  const m = buildManifest(catalog, ledger, V);
  assert.deepEqual(m.watchlist, watchlist(V, catalog, ledger).map((r) => r.id));
  assert.equal(m.watchlist.length, m.counts['CLOSED-NEGATIVE']);
});

/**
 * `inherited` has to survive into the manifest, because it is the difference between evidence
 * and measurement and a consumer that cares cannot recover it any other way.
 */
test('an inherited answer is marked as inherited', () => {
  const later = '1.26.30';
  const m = buildManifest(catalog, ledger, later);
  const row = m.capabilities.find((r) => r.id === 'item.max_durability.int16_ceiling')!;
  assert.equal(row.status, 'SETTLED');
  assert.equal(row.inherited, true);
  assert.equal(row.measured_on, V);
});

// ---------------------------------------------------------------------------
// Diffing, which is the changelog
// ---------------------------------------------------------------------------

test('a NO turning into a YES is reported as became_possible', () => {
  const id = 'render.attachable.reads_held_item_durability';
  const flipped: Observation[] = [
    ...ledger,
    {
      capability: id,
      version: '1.26.30',
      platform: 'client',
      method: 'observed',
      verdict: 'YES',
      outcome: 'flags_move',
      run: 'future',
      at: '2027-01-01T00:00:00Z',
    },
    // Its dependency has to hold at that version too, or the row resolves UNDERMINED rather
    // than SETTLED — which is the bisect floor doing its job.
    {
      capability: 'render.attachable.draws_on_custom_item',
      version: '1.26.30',
      platform: 'client',
      method: 'observed',
      verdict: 'YES',
      outcome: 'renders',
      run: 'future',
      at: '2027-01-01T00:00:00Z',
    },
  ];

  const before = buildManifest(catalog, ledger, V);
  const after = buildManifest(catalog, flipped, '1.26.30');
  const diff = diffManifests(before, after);

  assert.ok(
    diff.became_possible.some((r) => r.id === id),
    'a capability going from CLOSED-NEGATIVE to SETTLED must show up as became_possible',
  );
  assert.equal(diff.became_impossible.length, 0);
});

test('a YES turning into a NO is reported separately, because it means something else', () => {
  const id = 'item.max_durability.int16_ceiling';
  const regressed: Observation[] = [
    ...ledger,
    {
      capability: id,
      version: '1.26.30',
      platform: 'bds',
      method: 'automated',
      verdict: 'NO',
      run: 'future',
      at: '2027-01-01T00:00:00Z',
    },
  ];
  const diff = diffManifests(buildManifest(catalog, ledger, V), buildManifest(catalog, regressed, '1.26.30'));
  assert.ok(diff.became_impossible.some((r) => r.id === id));
  assert.equal(diff.became_possible.length, 0);
});

test('two identical manifests diff to nothing', () => {
  const m = buildManifest(catalog, ledger, V);
  const d = diffManifests(m, m);
  assert.deepEqual(
    [d.became_possible, d.became_impossible, d.newly_answered, d.no_longer_answered, d.added, d.removed],
    [[], [], [], [], [], []],
  );
});

/**
 * The tag scheme promises `mc-<version>-<revision>` is byte-identical forever. That is only true
 * if a manifest is a pure function of its inputs — and the first version of this file had a
 * wall-clock `generated_at`, which made every export differ, broke the committed-documents check
 * for no actionable reason, and would have made two people's "same" release incomparable.
 */
test('a manifest is byte-identical across exports', () => {
  const a = JSON.stringify(buildManifest(catalog, ledger, V));
  const b = JSON.stringify(buildManifest(catalog, ledger, V));
  assert.equal(a, b);
  assert.ok(!a.includes('generated_at'), 'a wall-clock field would break the immutable-tag promise');
});

test('measured_through is the newest observation the manifest rests on, not the newest anywhere', () => {
  const later: Observation[] = [
    ...ledger,
    {
      capability: 'item.max_durability.int16_ceiling',
      version: '1.26.30',
      platform: 'bds',
      method: 'automated',
      verdict: 'YES',
      run: 'future',
      at: '2027-06-01T00:00:00Z',
    },
  ];
  // The 1.26.30 observation is newer in time but ABOVE this manifest's version, and evidence
  // never inherits upward — so it is not part of what this manifest rests on.
  assert.notEqual(buildManifest(catalog, later, V).measured_through, '2027-06-01T00:00:00Z');
  assert.equal(buildManifest(catalog, later, '1.26.30').measured_through, '2027-06-01T00:00:00Z');
});
