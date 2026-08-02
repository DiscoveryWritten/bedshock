/**
 * The build-time assertion, which is the only part of this system another repository runs.
 *
 * Its job is to make one rule survive somebody being in a hurry: do not build on a capability
 * nobody measured. A citation and a guess look identical in a diff, so review does not catch
 * it; a failing build does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog } from './catalog.ts';
import { checkCitations, citationsIn } from './check.ts';
import type { Observation } from './types.ts';

const catalog = loadCatalog();

const obs = (over: Partial<Observation>): Observation => ({
  capability: 'item.max_durability.int16_ceiling',
  version: '1.21.120',
  platform: 'bds',
  method: 'automated',
  verdict: 'YES',
  run: 'r',
  at: '2026-08-02T00:00:00Z',
  ...over,
});

const cite = (id: string) => [{ id, file: 'src/gun.ts', line: 12 }];

test('citations are found regardless of comment syntax', () => {
  const source = [
    '/** @requires bedshock:item.max_durability.int16_ceiling */',
    '# @requires bedshock:item.name.glyph_renders_in_colour',
    'nothing here',
    '// two on @requires bedshock:entity.container.slots_are_untyped one line',
  ].join('\n');
  const found = citationsIn(source, 'x.ts');
  assert.deepEqual(
    found.map((c) => c.id),
    [
      'item.max_durability.int16_ceiling',
      'item.name.glyph_renders_in_colour',
      'entity.container.slots_are_untyped',
    ],
  );
  assert.equal(found[0]!.line, 1);
  assert.equal(found[2]!.line, 4);
});

test('a settled capability passes', () => {
  const result = checkCitations(cite('item.max_durability.int16_ceiling'), catalog, [obs({})], '1.21.120');
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test('an unmeasured capability fails the build', () => {
  const result = checkCitations(cite('item.max_durability.int16_ceiling'), catalog, [], '1.21.120');
  assert.equal(result.ok, false);
  assert.match(result.problems[0]!.message, /never measured/);
});

test('a capability measured NO fails the build', () => {
  const result = checkCitations(
    cite('item.max_durability.int16_ceiling'),
    catalog,
    [obs({ verdict: 'NO' })],
    '1.21.120',
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0]!.message, /the answer is NO/);
});

/**
 * The asymmetry, tested from the consumer's side. A pack declaring a floor of 1.21.120 cannot
 * be satisfied by a measurement taken on 1.26.30 — the newer engine is exactly where a thing
 * that did not used to work starts working.
 */
test('a measurement on a NEWER version does not satisfy an older floor', () => {
  const result = checkCitations(
    cite('item.max_durability.int16_ceiling'),
    catalog,
    [obs({ version: '1.26.30' })],
    '1.21.120',
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0]!.message, /never measured at or below 1\.21\.120/);
});

test('a measurement on an OLDER version passes with a warning', () => {
  const result = checkCitations(
    cite('item.max_durability.int16_ceiling'),
    catalog,
    [obs({ version: '1.21.20' })],
    '1.21.120',
  );
  assert.equal(result.ok, true);
  assert.equal(result.problems[0]!.severity, 'warning');
  assert.match(result.problems[0]!.message, /not re-checked/);
});

test('drift fails the build and says so in those words', () => {
  const result = checkCitations(
    cite('item.max_durability.int16_ceiling'),
    catalog,
    [obs({ verdict: 'YES', run: 'a', at: '2026-01-01T00:00:00Z' }), obs({ verdict: 'NO', run: 'b', at: '2026-02-01T00:00:00Z' })],
    '1.21.120',
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0]!.message, /NO LONGER HOLDS/);
});

test('an inconclusive run is not a soft pass', () => {
  const result = checkCitations(
    cite('item.max_durability.int16_ceiling'),
    catalog,
    [obs({ verdict: 'INCONCLUSIVE' })],
    '1.21.120',
  );
  assert.equal(result.ok, false);
  assert.match(result.problems[0]!.message, /Not a soft yes/);
});

test('citing a capability that does not exist fails, because ids are a public interface', () => {
  const result = checkCitations(cite('item.renamed.away'), catalog, [], '1.21.120');
  assert.equal(result.ok, false);
  assert.match(result.problems[0]!.message, /no such capability/);
});

/** Derived rows are legitimate to cite: they are established by reading, not by a probe. */
test('citing a derived capability passes without a measurement', () => {
  const derived = catalog.capabilities.find((c) => c.method === 'derived')!;
  const result = checkCitations(cite(derived.id), catalog, [], '1.21.120');
  assert.equal(result.ok, true);
});

test('a row resting on an open dependency warns rather than passing silently', () => {
  const dependent = catalog.capabilities.find(
    (c) => c.depends_on?.length && c.method !== 'derived',
  )!;
  const result = checkCitations(
    cite(dependent.id),
    catalog,
    [obs({ capability: dependent.id, method: dependent.method, verdict: 'YES', ...(dependent.method === 'observed' ? { outcome: dependent.outcomes!.find((o) => o.verdict === 'YES')!.id } : {}) })],
    '1.21.120',
  );
  assert.equal(result.problems[0]!.severity, 'warning');
  assert.match(result.problems[0]!.message, /rests on/);
});
