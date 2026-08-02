/**
 * The rollup, which is where every claim this repository makes actually gets made.
 *
 * There is no stored status anywhere. `SETTLED` is a function of observations, so these tests
 * are the specification of what the word means — including the two cases that are easy to get
 * wrong and expensive to get wrong: what counts as drift, and which direction evidence
 * inherits across versions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog } from './catalog.ts';
import { compareVersions, readLedger, resolve, resolveWithDeps, statusAt, validateLedger, versionsInLedger } from './ledger.ts';
import type { Capability, Observation, Verdict } from './types.ts';

const cap = (over: Partial<Capability> = {}): Capability => ({
  id: 'item.thing.works',
  question: 'q',
  decides: 'd',
  method: 'automated',
  surface: 'script',
  probe: 'thing',
  ...over,
});

let seq = 0;
const obs = (over: Partial<Observation> = {}): Observation => ({
  capability: 'item.thing.works',
  version: '1.21.120',
  platform: 'bds',
  method: 'automated',
  verdict: 'YES' as Verdict,
  run: `r${seq}`,
  at: new Date(1_700_000_000_000 + seq++ * 86_400_000).toISOString(),
  ...over,
});

// ---------------------------------------------------------------------------

test('versions compare numerically, not as strings', () => {
  assert.ok(compareVersions('1.21.120', '1.21.20') > 0, '1.21.120 is newer than 1.21.20');
  assert.ok(compareVersions('1.21.120', '1.26.30') < 0);
  assert.equal(compareVersions('1.21.120', '1.21.120'), 0);
  assert.deepEqual(
    versionsInLedger([obs({ version: '1.26.30' }), obs({ version: '1.21.20' }), obs({ version: '1.21.120' })]),
    ['1.21.20', '1.21.120', '1.26.30'],
  );
});

test('nothing measured is OPEN, not NO', () => {
  assert.equal(statusAt(cap(), '1.21.120', []).status, 'OPEN');
});

test('a YES is SETTLED and a NO is CLOSED-NEGATIVE', () => {
  assert.equal(statusAt(cap(), '1.21.120', [obs({ verdict: 'YES' })]).status, 'SETTLED');
  assert.equal(statusAt(cap(), '1.21.120', [obs({ verdict: 'NO' })]).status, 'CLOSED-NEGATIVE');
});

test('an INCONCLUSIVE run is not a soft NO', () => {
  assert.equal(statusAt(cap(), '1.21.120', [obs({ verdict: 'INCONCLUSIVE' })]).status, 'INCONCLUSIVE');
});

// --- drift -----------------------------------------------------------------

test('two runs on the same version disagreeing is DRIFT', () => {
  const status = statusAt(cap(), '1.21.120', [obs({ verdict: 'YES' }), obs({ verdict: 'NO' })]);
  assert.equal(status.status, 'DRIFT');
  assert.match(status.conflict!, /same version, different answers/);
});

/**
 * The subtle one. A verdict can hold steady while the numbers underneath it move, and for the
 * durability ceilings that is exactly the change that would matter: everything still "reports
 * what was declared" if the boundary itself moved.
 */
test('the same verdict with a different measurement is also DRIFT', () => {
  const status = statusAt(cap(), '1.21.120', [
    obs({ verdict: 'YES', measurement: { ceiling: 32767 } }),
    obs({ verdict: 'YES', measurement: { ceiling: 65535 } }),
  ]);
  assert.equal(status.status, 'DRIFT');
  assert.match(status.conflict!, /same verdict, different measurement/);
});

test('an inconclusive run does not drift against a good one', () => {
  const status = statusAt(cap(), '1.21.120', [obs({ verdict: 'YES' }), obs({ verdict: 'INCONCLUSIVE' })]);
  assert.equal(status.status, 'SETTLED');
});

test('a disagreement across two DIFFERENT versions is not drift — it is the finding', () => {
  const observations = [obs({ version: '1.21.120', verdict: 'NO' }), obs({ version: '1.26.30', verdict: 'YES' })];
  assert.equal(statusAt(cap(), '1.21.120', observations).status, 'CLOSED-NEGATIVE');
  assert.equal(statusAt(cap(), '1.26.30', observations).status, 'SETTLED');
});

// --- inheritance -----------------------------------------------------------

test('evidence inherits DOWNWARD to a later version', () => {
  const resolved = resolve(cap(), '1.21.130', [obs({ version: '1.21.120', verdict: 'YES' })]);
  assert.equal(resolved.status, 'SETTLED');
  assert.equal(resolved.inherited, true);
  assert.equal(resolved.measuredAt, '1.21.120');
});

/**
 * The asymmetry that keeps a pack honest. A newer engine is exactly where something that did
 * not used to work starts working, so a measurement on 1.26.30 says nothing whatsoever about a
 * pack declaring it runs on 1.21.120 — and treating it as evidence would ship a pack that
 * loads for nobody.
 */
test('evidence never inherits UPWARD to an earlier version', () => {
  const resolved = resolve(cap(), '1.21.120', [obs({ version: '1.26.30', verdict: 'YES' })]);
  assert.equal(resolved.status, 'OPEN');
  assert.equal(resolved.inherited, false);
});

test('inheritance takes the newest answer at or below the version asked about', () => {
  const resolved = resolve(cap(), '1.26.30', [
    obs({ version: '1.21.20', verdict: 'NO' }),
    obs({ version: '1.21.120', verdict: 'YES' }),
  ]);
  assert.equal(resolved.measuredAt, '1.21.120');
  assert.equal(resolved.status, 'SETTLED');
});

// --- dependencies ----------------------------------------------------------

test('a settled row resting on an open one is UNDERMINED', () => {
  const catalog = {
    byId: new Map([
      ['item.floor.works', cap({ id: 'item.floor.works' })],
      ['item.thing.works', cap({ depends_on: ['item.floor.works'] })],
    ]),
  } as never as import('./catalog.ts').Catalog;

  const resolved = resolveWithDeps(
    cap({ depends_on: ['item.floor.works'] }),
    '1.21.120',
    [obs({ verdict: 'YES' })],
    catalog,
  );
  assert.equal(resolved.status, 'UNDERMINED');
  assert.match(resolved.conflict!, /rests on item\.floor\.works/);
});

test('a settled row resting on a settled one stays settled', () => {
  const catalog = {
    byId: new Map([['item.floor.works', cap({ id: 'item.floor.works' })]]),
  } as never as import('./catalog.ts').Catalog;

  const resolved = resolveWithDeps(
    cap({ depends_on: ['item.floor.works'] }),
    '1.21.120',
    [obs({ verdict: 'YES' }), obs({ capability: 'item.floor.works', verdict: 'YES' })],
    catalog,
  );
  assert.equal(resolved.status, 'SETTLED');
});

// --- validation ------------------------------------------------------------

test('the shipped ledger agrees with the shipped catalog', () => {
  assert.deepEqual(validateLedger(readLedger(), loadCatalog()), []);
});

/**
 * The one edit that would make the whole system worthless, and it is invisible by reading: an
 * observation whose recorded verdict does not match what the outcome it was picked from means.
 */
test('an observation whose verdict contradicts its own outcome is refused', () => {
  const catalog = loadCatalog();
  const observed = catalog.capabilities.find((c) => c.method === 'observed' && c.outcomes?.length)!;
  const no = observed.outcomes!.find((o) => o.verdict === 'NO')!;
  const problems = validateLedger(
    [obs({ capability: observed.id, method: 'observed', verdict: 'YES', outcome: no.id })],
    catalog,
  );
  assert.match(problems.join('\n'), /means NO, but the observation says YES/);
});

test('an observation for an unknown capability is refused', () => {
  const problems = validateLedger([obs({ capability: 'item.made.up' })], loadCatalog());
  assert.match(problems.join('\n'), /no such capability/);
});

test('an observed capability answered without naming an outcome is refused', () => {
  const catalog = loadCatalog();
  const observed = catalog.capabilities.find((c) => c.method === 'observed')!;
  const problems = validateLedger([obs({ capability: observed.id, method: 'observed' })], catalog);
  assert.match(problems.join('\n'), /must record which outcome/);
});
