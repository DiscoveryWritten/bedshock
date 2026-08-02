/**
 * The one property of a packaged world that matters, and the reason it went unchecked.
 *
 * `bedshock run --world-out` existed for months, was wired through `run.ts`, was named in the
 * release workflow, and wrote nothing. `bds.sh` never read the variable. Downstream,
 * `release.yml` guarded the upload with `if [ -f dist/bedshock-world.mcworld ]` and moved on
 * silently when the file was not there — so a flag that did nothing produced a release that
 * looked complete.
 *
 * A tolerant check downstream is how a silent nothing survives. These are the intolerant ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSelfContained, packWorld, worldEntries } from './world.ts';

/** A world and a built pack tree, minimal but shaped exactly like the real thing. */
function rig(): { worldDir: string; buildDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'bedshock-world-'));
  const worldDir = join(root, 'world');
  const buildDir = join(root, 'build');

  mkdirSync(join(worldDir, 'db'), { recursive: true });
  writeFileSync(join(worldDir, 'level.dat'), Buffer.from([1, 2, 3]));
  writeFileSync(join(worldDir, 'levelname.txt'), 'bedshock');
  writeFileSync(join(worldDir, 'db', '000001.log'), Buffer.from([4, 5]));

  mkdirSync(join(buildDir, 'BP', 'scripts'), { recursive: true });
  mkdirSync(join(buildDir, 'RP'), { recursive: true });
  writeFileSync(
    join(buildDir, 'BP', 'manifest.json'),
    JSON.stringify({ header: { uuid: 'bp-uuid-1111', version: [0, 1, 0] } }),
  );
  writeFileSync(join(buildDir, 'BP', 'scripts', 'main.js'), '// battery');
  writeFileSync(
    join(buildDir, 'RP', 'manifest.json'),
    JSON.stringify({ header: { uuid: 'rp-uuid-2222', version: [0, 1, 0] } }),
  );
  return { worldDir, buildDir };
}

// ---------------------------------------------------------------------------

/**
 * THE WHOLE POINT. A world that merely NAMES two UUIDs demands the pack manager, and the pack
 * manager is the three minutes of tapping this exists to delete: an `.mcaddon` whose UUID is
 * already installed is refused as a duplicate, the client caches hard enough to need an app
 * restart, and a hundred dead versions pile up in storage behind it.
 *
 * Packs INSIDE the archive are world-local. Nothing is installed, so there is nothing to
 * uninstall and nothing to collide.
 */
test('the archive carries the packs, not just a reference to them', () => {
  const { worldDir, buildDir } = rig();
  const entries = worldEntries({ worldDir, buildDir });
  const paths = entries.map((e) => e.path);

  assert.ok(paths.includes('behavior_packs/bedshock/manifest.json'), 'the behaviour pack is not in the archive');
  assert.ok(paths.includes('behavior_packs/bedshock/scripts/main.js'), 'the script is not in the archive');
  assert.ok(paths.includes('resource_packs/bedshock/manifest.json'), 'the resource pack is not in the archive');
  assert.ok(isSelfContained(entries));

  // And a world with only the bindings must NOT pass, or the guard is decoration.
  assert.ok(
    !isSelfContained([
      { path: 'level.dat', data: Buffer.alloc(0) },
      { path: 'world_behavior_packs.json', data: Buffer.alloc(0) },
      { path: 'world_resource_packs.json', data: Buffer.alloc(0) },
    ]),
  );
});

test('the world itself travels', () => {
  const { worldDir, buildDir } = rig();
  const paths = worldEntries({ worldDir, buildDir }).map((e) => e.path);
  assert.ok(paths.includes('level.dat'));
  assert.ok(paths.includes('levelname.txt'));
  assert.ok(paths.includes('db/000001.log'), 'the chunk database did not travel — the world would be empty');
});

/**
 * The bindings are written from the manifests rather than passed in, so they cannot name a
 * version the archive does not contain. A world bound to a pack version that is not there loads
 * with the pack silently off, which looks exactly like a battery that found nothing.
 */
test('the bindings are derived from the packs actually in the archive', () => {
  const { worldDir, buildDir } = rig();
  const entries = worldEntries({ worldDir, buildDir });
  const read = (path: string) => JSON.parse(String(entries.find((e) => e.path === path)!.data));

  assert.deepEqual(read('world_behavior_packs.json'), [{ pack_id: 'bp-uuid-1111', version: [0, 1, 0] }]);
  assert.deepEqual(read('world_resource_packs.json'), [{ pack_id: 'rp-uuid-2222', version: [0, 1, 0] }]);
});

/** A server that ran with globally installed packs leaves its own copies behind. Ours win. */
test('a stale pack folder left by the server does not shadow the one being packaged', () => {
  const { worldDir, buildDir } = rig();
  mkdirSync(join(worldDir, 'behavior_packs', 'bedshock'), { recursive: true });
  writeFileSync(join(worldDir, 'behavior_packs', 'bedshock', 'manifest.json'), '{"header":{"uuid":"stale"}}');
  writeFileSync(join(worldDir, 'world_behavior_packs.json'), '[{"pack_id":"stale","version":[9,9,9]}]');

  const entries = worldEntries({ worldDir, buildDir });
  const manifests = entries.filter((e) => e.path === 'behavior_packs/bedshock/manifest.json');
  assert.equal(manifests.length, 1, 'the archive carries two manifests at one path');
  assert.match(String(manifests[0]!.data), /bp-uuid-1111/, 'the stale copy won');

  const bindings = entries.filter((e) => e.path === 'world_behavior_packs.json');
  assert.equal(bindings.length, 1);
  assert.match(String(bindings[0]!.data), /bp-uuid-1111/);
});

/**
 * Failing loudly is the correction for what happened here. The flag was accepted, wrote nothing,
 * and the release workflow tolerated the absence — so nobody found out for months.
 */
test('a missing world or pack is an error rather than an empty archive', () => {
  const { worldDir, buildDir } = rig();
  assert.throws(() => worldEntries({ worldDir: join(worldDir, 'nope'), buildDir }), /no world at/);
  assert.throws(() => worldEntries({ worldDir, buildDir: join(buildDir, 'nope') }), /no behavior pack at/);
});

test('the archive is real bytes and says what it is', () => {
  const { worldDir, buildDir } = rig();
  const packed = packWorld({ worldDir, buildDir });
  // Local file header magic. A zip Minecraft will not open is not a world.
  assert.equal(packed.bytes.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(packed.summary, /World-local/);
  assert.match(packed.summary, /nothing to collide/);
});
