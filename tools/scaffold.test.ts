/**
 * The scaffold has to actually run.
 *
 * A starter that needs editing before `validate` passes teaches its first lesson by failing, and
 * the lesson is "this is fiddly" — which is the opposite of the point. The whole reason
 * `bedshock init` exists is that the distance between "vendoring this is possible" and "somebody
 * did it" is made entirely of blank files.
 *
 * So: the emitted catalog is loaded by the real loader, against the real validator, with no
 * edits. If a rule is added to `catalog.ts` and the scaffold does not satisfy it, this is what
 * says so — rather than the first person who tries it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadCatalog } from './catalog.ts';
import { buildManifest } from './manifest.ts';
import { scaffold } from './scaffold.ts';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'bedshock-init-'));
}

test('what `bedshock init` writes loads and validates unedited', () => {
  const dir = fresh();
  scaffold({ dir, domain: 'portals', bedshock: '../vendor/bedshock' });

  const catalog = loadCatalog(join(dir, 'capabilities'));
  assert.equal(catalog.capabilities.length, 1);
  const cap = catalog.capabilities[0]!;
  assert.equal(cap.id, 'portals.example.threshold');
  assert.equal(cap.method, 'solved');
  // Every rule a solved row has to satisfy, satisfied by the example rather than described in a
  // comment above it.
  assert.ok(cap.measures?.unit);
  assert.ok((cap.measures?.tolerance ?? 0) > 0);
  assert.ok(cap.measures?.search && cap.measures.search.to > cap.measures.search.from);
  assert.ok(cap.surface);
});

/** The artifact is the point. An empty ledger still has to produce one. */
test('a scaffolded catalog with no answers yet still exports a manifest', () => {
  const dir = fresh();
  scaffold({ dir, domain: 'portals', bedshock: '../vendor/bedshock' });
  const manifest = buildManifest(loadCatalog(join(dir, 'capabilities')), [], '1.26.30');
  assert.equal(manifest.capabilities.length, 1);
  assert.equal(manifest.capabilities[0]!.status, 'OPEN');
  // The release tag is what makes it citable, and it must not depend on our catalog at all.
  assert.match(manifest.release, /^mc-1\.26\.30-r[0-9a-f]{8}$/);
});

test('the domain is what every id and both file names are built from', () => {
  const dir = fresh();
  const { written } = scaffold({ dir, domain: 'my-pack!', bedshock: '../b' });
  assert.ok(written.some((p) => p.endsWith(join('capabilities', 'my_pack_.yaml'))));
  assert.ok(written.some((p) => p.endsWith(join('probes', 'my_pack_.ts'))));
  assert.equal(loadCatalog(join(dir, 'capabilities')).capabilities[0]!.id.split('.')[0], 'my_pack_');
});

/**
 * The probe has to import from the harness, not from our internals.
 *
 * Everything else under `pack/scripts/` is this repository's own instruments and they will move.
 * A scaffold that reached past `harness.ts` would break on our next refactor, in somebody else's
 * repository, for a reason nothing in their code explains.
 */
test('the scaffolded probe imports the harness and nothing deeper', () => {
  const dir = fresh();
  scaffold({ dir, domain: 'portals', bedshock: '../vendor/bedshock' });
  const source = readFileSync(join(dir, 'probes', 'portals.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
  for (const path of imports) {
    if (path.startsWith('@minecraft/')) continue;
    assert.equal(path, '../vendor/bedshock/pack/scripts/harness.ts', `reaches past the harness: ${path}`);
  }
  // And the capability it reports is the one the catalog declares, or the collector would drop
  // every result it ever produced with a warning nobody reads.
  const cap = loadCatalog(join(dir, 'capabilities')).capabilities[0]!;
  assert.ok(source.includes(`'${cap.id}'`), 'the probe and the catalog disagree about the id');
});

/**
 * The most likely second run of `init` is a mistake, and the most likely thing to lose is a
 * ledger — which is append-only precisely because what is in it cannot be re-derived.
 */
test('a second init never overwrites, least of all the ledger', () => {
  const dir = fresh();
  scaffold({ dir, domain: 'portals', bedshock: '../vendor/bedshock' });
  const ledger = join(dir, 'observations.jsonl');
  writeFileSync(ledger, '{"kept":true}\n');

  const again = scaffold({ dir, domain: 'portals', bedshock: '../vendor/bedshock' });
  assert.deepEqual(again.written, []);
  assert.equal(again.skipped.length, 4);
  assert.equal(readFileSync(ledger, 'utf8'), '{"kept":true}\n');
});
