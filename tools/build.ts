/**
 * Building the probe pack.
 *
 * `content/pack.yaml` -> generated ids module -> esbuild bundle -> BP + RP -> `.mcaddon`.
 *
 * ONE CHECK HERE IS NOT COSMETIC. The build cross-references the emitted pack against the
 * capability catalog and reports any capability whose named probe has no runtime, and any
 * probe emitting results nothing in the catalog asks for. Both are silent failures otherwise:
 * a capability pointing at a probe that does not exist sits in the matrix looking like a
 * question somebody could go and answer, and a probe reporting a capability id with a typo in
 * it produces a line the ledger quietly drops.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build as esbuild } from 'esbuild';

import { loadPackConfig, type PackConfig } from './config.ts';
import { loadCatalog } from './catalog.ts';
import { generatedModule, packFiles, sessionModule, type OutFile } from './gen/pack.ts';
import { readLedger, latestVersion } from './ledger.ts';
import { zip } from './zip.ts';
import { BUILD_DIR, DIST_DIR, PACK_DIR } from './paths.ts';

export interface BuildResult {
  buildDir: string;
  addon: string;
  files: number;
  warnings: string[];
}

/**
 * Which capability ids the runtime actually reports.
 *
 * Read out of the bundled script rather than out of the sources, so it reflects what will
 * really run — a probe left out of the registry in `main.ts` is tree-shaken away and correctly
 * counts as absent.
 */
function reportedCapabilities(bundle: string): Set<string> {
  const ids = new Set<string>();
  for (const m of bundle.matchAll(/["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,})["'`]/g)) {
    ids.add(m[1]!);
  }
  return ids;
}

/**
 * The embedded catalog put every id in the bundle, and quietly switched this check off.
 *
 * The session carries its questions as data because a client cannot fetch them. That data is a
 * JSON literal full of capability ids, so from the day it was added the scan above matched every
 * row in the catalog and the "no runtime for this" warning stopped ever firing — with no error,
 * no failing test, and a build that looked exactly as clean as it had the day before. A check
 * that cannot fail is worse than no check, because people believe it.
 *
 * The two are told apart by SHAPE rather than by id, because a solved row legitimately appears in
 * both: `"id": "x"` is a row of embedded data, and a bare `"x"` is code naming the capability it
 * reports. Subtracting by id would have marked every solved probe unimplemented the moment its
 * question was embedded.
 *
 * What being embedded DOES buy is the guided session: an `observed` row in `QUESTIONS` is one a
 * person can genuinely be asked — BUT ONLY IF THERE IS SOMETHING TO LOOK AT. That second half was
 * missing, and it switched the check off a second time.
 *
 * Being asked "hold the attachable probe and read the four flags" is worthless when the pack emits
 * no attachable. Crediting every embedded `observed` row hid exactly that: eight rows across three
 * rigs — `attachable`, `attachable_pose`, `stash` — named probes this pack has never built, and the
 * build reported a clean bill on every run. `docs/CAPABILITIES.md` in composable-portals had been
 * telling people to rely on this list to know when its own copies were safe to delete.
 *
 * So an observed row is credited only when its `probe` is one the pack IMPLEMENTS, read below.
 */
const DATA_ID = /(["']?id["']?\s*:\s*)(["'])[^"']+\2/g;

/**
 * Which probes this pack actually runs, read out of the registry in the bundle.
 *
 * From the BUNDLE, for the same reason the ids are: the registry in `main.ts` is what decides
 * whether a probe has a runtime, and a probe left out of it is tree-shaken away no matter how
 * much source sits behind it.
 *
 * RETURNS NULL WHEN IT CANNOT TELL, and callers must treat that as a finding rather than as an
 * empty set. Reading a name out of compiled output is the sort of thing that stops working
 * quietly — a renamed binding, a different emit shape — and the failure mode of a silent empty
 * set is every capability reported unimplemented, which is noise people learn to scroll past.
 * `tools/pack.test.ts` pins that this finds the real registry.
 */
export function implementedProbes(bundle: string): Set<string> | null {
  const found = bundle.match(/\b(?:var|const|let)\s+PROBES\s*=\s*\{([\s\S]*?)\n\};/);
  if (!found) return null;
  const names = new Set<string>();
  // Both spellings, because esbuild emits whichever the source used and `ruler,` is a probe
  // exactly as much as `ruler: run` is. Missing the shorthand form reported four built probes as
  // unbuilt, which is the same wrong answer as the bug this function exists to fix.
  for (const m of found[1]!.matchAll(/^\s{2}([a-zA-Z_$][\w$]*)\s*(:|,\s*$)/gm)) names.add(m[1]!);
  return names.size ? names : null;
}

export function crossCheck(bundle: string, embedded: string): string[] {
  const catalog = loadCatalog();
  const warnings: string[] = [];
  const carried = reportedCapabilities(embedded);
  const reported = reportedCapabilities(bundle.replace(DATA_ID, '$1$2$2'));

  const implemented = implementedProbes(bundle);
  if (!implemented) {
    warnings.push(
      `the probe registry could not be read out of the bundle, so nothing below can distinguish ` +
        `a question this pack can ask from one it merely carries the text of. Fix ` +
        `\`implementedProbes\` before trusting this build's clean bill.`,
    );
  }

  // An observed row needs BOTH halves: a question the session can put to somebody, and apparatus
  // for them to look at. Either one alone is a person being asked about nothing.
  for (const cap of catalog.capabilities) {
    if (cap.method !== 'observed' || !carried.has(cap.id)) continue;
    if (implemented && cap.probe && !implemented.has(cap.probe)) continue;
    reported.add(cap.id);
  }

  // The list composable-portals is waiting on: every rig named by the catalog and built by
  // nobody. Reported separately from the ids, because one missing rig silences several rows and
  // the thing to go and build is the rig.
  if (implemented) {
    const unbuilt = new Map<string, string[]>();
    for (const cap of catalog.capabilities) {
      if (cap.method === 'derived' || !cap.probe || implemented.has(cap.probe)) continue;
      unbuilt.set(cap.probe, [...(unbuilt.get(cap.probe) ?? []), cap.id]);
    }
    if (unbuilt.size) {
      warnings.push(
        `${unbuilt.size} probe(s) are named by the catalog and built by nothing. Until they ` +
          `exist, their questions can only ever be re-answered by hand — and on a NEW Minecraft ` +
          `version, not at all:\n` +
          [...unbuilt]
            .map(([probe, ids]) => `    ${probe}\n${ids.map((id) => `      ${id}`).join('\n')}`)
            .join('\n'),
      );
    }
  }

  const measurable = catalog.capabilities.filter((c) => c.method !== 'derived');
  const unimplemented = measurable.filter((c) => !reported.has(c.id));
  if (unimplemented.length) {
    warnings.push(
      `${unimplemented.length} capability(s) have no runtime in this pack. They will sit in the ` +
        `matrix as unanswerable rather than merely unanswered:\n` +
        unimplemented.map((c) => `    ${c.id}  (probe: ${c.probe ?? 'none'})`).join('\n'),
    );
  }

  const known = new Set(catalog.capabilities.map((c) => c.id));
  const orphans = [...reported].filter((id) => !known.has(id) && id.split('.').length >= 3 && !id.includes('minecraft'));
  if (orphans.length) {
    warnings.push(
      `the runtime mentions ${orphans.length} dotted id(s) the catalog does not declare. If any of ` +
        `these is a capability, a typo means its results are silently dropped:\n` +
        orphans.map((id) => `    ${id}`).join('\n'),
    );
  }

  return warnings;
}

export async function build(config: PackConfig = loadPackConfig()): Promise<BuildResult> {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  // The generated ids module, written next to the sources so esbuild resolves it normally.
  // Regenerated on every build: the runtime must never know an id the generator did not emit.
  writeFileSync(join(PACK_DIR, 'scripts', 'generated.ts'), generatedModule(config));

  // The questions the guided session asks, embedded because a client cannot fetch anything. The
  // snapshot is taken at the newest version the ledger knows, which is what "published per
  // version" means in practice: this pack and the manifest beside it are one artifact.
  const observations = readLedger();
  const snapshotVersion = latestVersion(observations) ?? config.min_engine_version.join('.');
  const embedded = sessionModule(loadCatalog(), observations, snapshotVersion);
  writeFileSync(join(PACK_DIR, 'scripts', 'catalog.generated.ts'), embedded);

  const files: OutFile[] = packFiles(config);

  const bundleOut = join(BUILD_DIR, 'BP', 'scripts', 'main.js');
  mkdirSync(dirname(bundleOut), { recursive: true });
  await esbuild({
    entryPoints: [join(PACK_DIR, 'scripts', 'main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: bundleOut,
    // Never bundled: these are provided by the game, and inlining them would produce a pack
    // that loads and then does nothing.
    external: ['@minecraft/server', '@minecraft/server-ui'],
    // Bedrock's script engine is not a browser and nothing minifies usefully here, but the
    // banner is worth having: a log line quoting a stack trace is much easier to place.
    banner: { js: `// bedshock ${config.version.join('.')} — capability battery. Generated; do not edit.` },
  });

  const bundle = readFileSync(bundleOut, 'utf8');
  const warnings = crossCheck(bundle, embedded);

  for (const file of files) {
    const path = join(BUILD_DIR, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.data);
  }

  mkdirSync(DIST_DIR, { recursive: true });
  const entries = [
    ...files.map((f) => ({ path: f.path, data: Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8') })),
    { path: 'BP/scripts/main.js', data: Buffer.from(bundle, 'utf8') },
  ];
  const addon = join(DIST_DIR, `bedshock-${config.version.join('.')}.mcaddon`);
  writeFileSync(addon, zip(entries));

  return { buildDir: BUILD_DIR, addon, files: entries.length, warnings };
}

/** Copy a built tree somewhere a server can load it from. */
export function installInto(serverDir: string, buildDir = BUILD_DIR): void {
  cpSync(join(buildDir, 'BP'), join(serverDir, 'behavior_packs', 'bedshock'), { recursive: true });
  cpSync(join(buildDir, 'RP'), join(serverDir, 'resource_packs', 'bedshock'), { recursive: true });
}
