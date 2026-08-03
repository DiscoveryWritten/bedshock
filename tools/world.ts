/**
 * Packaging a world you can import with two taps and nothing else.
 *
 * THE PROBLEM THIS EXISTS FOR IS NOT MINECRAFT'S, IT IS THE PACK MANAGER'S. Installing an
 * `.mcaddon` whose UUID is already present is refused as a duplicate — Bedrock will not replace
 * it, only marketplace content updates in place — so every rebuild means uninstalling the old
 * copy first, and the client caches hard enough that the app has to be closed before the new one
 * takes. Then the world has to be recreated, renamed, set to creative, given cheats, and told
 * about both packs. Three minutes of tapping before any measuring starts, and a hundred dead
 * versions accumulating in storage behind it.
 *
 * A WORLD CAN CARRY ITS OWN PACKS, and that route bypasses the pack manager entirely. Packs
 * inside `<world>/behavior_packs/` and `<world>/resource_packs/`, bound by the two json files at
 * the world root, are world-local: never installed globally, so there is nothing to uninstall,
 * nothing to collide, nothing cached and nothing accumulating. Delete the old world, open the new
 * `.mcworld`, join. The generator is already flat, creative and cheats travel in `level.dat`.
 *
 * THE FLAG WAS ACCEPTED AND IGNORED. `bedshock run --world-out` has existed for a while, and
 * `release.yml` has been checking `if [ -f dist/bedshock-world.mcworld ]` and quietly moving on
 * when nothing was there. Nothing ever wrote it. A flag that silently does nothing is the same
 * failure as a probe that silently records nothing, and it survived precisely because the check
 * downstream was written to tolerate absence.
 *
 * So the assembly lives here rather than in `bds.sh`: a function that returns its entry list can
 * be asserted against, and the one property that matters — that the archive contains the packs
 * and not just a reference to them — is exactly the property a test can check without a client.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { zip, type ZipEntry } from './zip.ts';

export interface WorldPackOptions {
  /** The world directory a server produced: `level.dat`, `db/`, and so on. */
  worldDir: string;
  /** The built pack tree, containing `BP/` and `RP/`. */
  buildDir: string;
  /** Pack folder name inside the world. Anything stable; it is not user-visible. */
  name?: string;
}

/** Every file in a directory tree, as archive-relative paths with forward slashes. */
function walk(dir: string, prefix = ''): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const at = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, at));
    } else {
      out.push({ path: at, data: readFileSync(full) });
    }
  }
  return out;
}

function uuidOf(manifest: string): { uuid: string; version: number[] } {
  const parsed = JSON.parse(manifest) as { header: { uuid: string; version: number[] } };
  return { uuid: parsed.header.uuid, version: parsed.header.version };
}

/**
 * Assemble the entries for a `.mcworld`: the world, plus the packs, plus the bindings.
 *
 * Returned rather than written so the caller can inspect it, and so the test that guards
 * self-containment does not need a server to have run.
 */
export function worldEntries(opts: WorldPackOptions): ZipEntry[] {
  const name = opts.name ?? 'bedshock';
  const bpDir = join(opts.buildDir, 'BP');
  const rpDir = join(opts.buildDir, 'RP');
  for (const [what, dir] of [['world', opts.worldDir], ['behavior pack', bpDir], ['resource pack', rpDir]] as const) {
    if (!existsSync(dir)) throw new Error(`cannot package a world: no ${what} at ${dir}`);
  }

  const bp = uuidOf(readFileSync(join(bpDir, 'manifest.json'), 'utf8'));
  const rp = uuidOf(readFileSync(join(rpDir, 'manifest.json'), 'utf8'));

  const entries: ZipEntry[] = [];
  const add = (path: string, data: Buffer): void => {
    entries.push({ path, data });
  };

  // The world itself. A server leaves its own copies of the binding files behind; they are
  // rewritten below, so skip them here rather than emitting each twice.
  const bindings = new Set(['world_behavior_packs.json', 'world_resource_packs.json']);
  for (const file of walk(opts.worldDir)) {
    if (bindings.has(file.path)) continue;
    // A server that ran with packs installed globally may also have left its own pack folders
    // in the world. Ours are written fresh below and must not be shadowed.
    if (file.path.startsWith('behavior_packs/') || file.path.startsWith('resource_packs/')) continue;
    add(file.path, file.data);
  }

  // THE PACKS THEMSELVES. This is the whole point: without these the archive is a world that
  // merely names two UUIDs and expects somebody to have installed them.
  for (const file of walk(bpDir)) add(`behavior_packs/${name}/${file.path}`, file.data);
  for (const file of walk(rpDir)) add(`resource_packs/${name}/${file.path}`, file.data);

  // And the bindings, written from the manifests rather than passed in, so they cannot drift
  // from the packs actually in the archive.
  add(
    'world_behavior_packs.json',
    Buffer.from(`${JSON.stringify([{ pack_id: bp.uuid, version: bp.version }], null, 2)}\n`, 'utf8'),
  );
  add(
    'world_resource_packs.json',
    Buffer.from(`${JSON.stringify([{ pack_id: rp.uuid, version: rp.version }], null, 2)}\n`, 'utf8'),
  );

  return entries;
}

export interface PackedWorld {
  entries: ZipEntry[];
  bytes: Buffer;
  /** What a person needs to be told, printed by `bedshock run`. */
  summary: string;
}

export function packWorld(opts: WorldPackOptions): PackedWorld {
  const entries = worldEntries(opts);
  const bytes = zip(entries.map((e) => ({ path: e.path, data: e.data })));
  const packFiles = entries.filter((e) => e.path.startsWith('behavior_packs/') || e.path.startsWith('resource_packs/'));
  return {
    entries,
    bytes,
    summary:
      `${entries.length} file(s), ${packFiles.length} of them the packs themselves. ` +
      `World-local: importing this touches nothing in the global pack list, so there is no old ` +
      `copy to uninstall and nothing to collide with.`,
  };
}

/** True when the archive really carries its packs rather than merely naming them. */
export function isSelfContained(entries: readonly ZipEntry[]): boolean {
  const paths = entries.map((e) => e.path);
  const has = (prefix: string, tail: string): boolean =>
    paths.some((p) => p.startsWith(prefix) && p.endsWith(tail));
  return (
    has('behavior_packs/', 'manifest.json') &&
    has('resource_packs/', 'manifest.json') &&
    paths.includes('world_behavior_packs.json') &&
    paths.includes('world_resource_packs.json')
  );
}

/** Normalise a path the way an archive wants it, whatever the host separator is. */
export function archivePath(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}
