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
import { generatedModule, packFiles, type OutFile } from './gen/pack.ts';
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

function crossCheck(bundle: string): string[] {
  const catalog = loadCatalog();
  const warnings: string[] = [];
  const reported = reportedCapabilities(bundle);

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
  const warnings = crossCheck(bundle);

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
