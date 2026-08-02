/**
 * The public surface, for a pack that depends on this at build time.
 *
 * A host pack should never reach into the ledger file or the capability YAML directly. Those
 * are this repository's internals and they will change shape; these five functions are the
 * contract, and they are deliberately narrow.
 *
 * Typical use, from a host build:
 *
 *     import { requireCapabilities } from 'bedshock';
 *
 *     requireCapabilities({
 *       version: manifest.min_engine_version.join('.'),
 *       ids: ['item.max_durability.int16_ceiling', 'item.dynamic_properties.survive_get_set_round_trip'],
 *     });   // throws if any is not settled at or below that floor
 *
 * or, if the pack prefers to cite capabilities where it uses them rather than in a list, the
 * `@requires bedshock:<id>` comment convention plus `bedshock check` from a build script. Both
 * do the same work; the comment form keeps the citation next to the code that rests on it,
 * which is the version less likely to go stale.
 */

import { loadCatalog, type Catalog } from './catalog.ts';
import { readLedger, resolveWithDeps, versionsInLedger, type Resolved } from './ledger.ts';
import type { Observation } from './types.ts';

export type { Capability, Observation, Status, Verdict, Method } from './types.ts';
export type { Resolved } from './ledger.ts';
export { loadCatalog } from './catalog.ts';
export { readLedger, compareVersions, versionsInLedger } from './ledger.ts';
export { checkCitations, collectCitations, citationsIn, formatCheckResult } from './check.ts';

let cached: { catalog: Catalog; observations: Observation[] } | undefined;

function loaded(): { catalog: Catalog; observations: Observation[] } {
  cached ??= { catalog: loadCatalog(), observations: readLedger() };
  return cached;
}

/** What one capability is on one version, with its dependency chain taken into account. */
export function capabilityStatus(id: string, version: string): Resolved {
  const { catalog, observations } = loaded();
  const cap = catalog.byId.get(id);
  if (!cap) throw new Error(`bedshock: no capability "${id}"`);
  return resolveWithDeps(cap, version, observations, catalog);
}

/** True only for `SETTLED`. `UNDERMINED` and `DRIFT` are deliberately not settled. */
export function isSettled(id: string, version: string): boolean {
  return capabilityStatus(id, version).status === 'SETTLED';
}

export interface RequireOptions {
  ids: string[];
  version: string;
  /**
   * Treat a capability settled on an OLDER version but not re-checked on this one as a
   * failure. Off by default — patch versions rarely remove things, and demanding a fresh run
   * for every Bedrock release would make the check something people switch off.
   */
  strictVersionMatch?: boolean;
}

/**
 * Throw unless every listed capability is settled at or below `version`.
 *
 * The error names every failing row and says what is wrong with each, rather than stopping at
 * the first — a build that fails one capability at a time across five rebuilds is a build
 * people learn to route around.
 */
export function requireCapabilities(opts: RequireOptions): void {
  const failures: string[] = [];
  for (const id of opts.ids) {
    const status = capabilityStatus(id, opts.version);
    if (status.status === 'SETTLED' && (!status.inherited || !opts.strictVersionMatch)) continue;
    if (status.status === 'SETTLED' && status.inherited) {
      failures.push(`  ${id}: settled on ${status.measuredAt}, never re-checked on ${opts.version}`);
      continue;
    }
    const detail = status.conflict ? ` — ${status.conflict}` : '';
    const where = status.measuredAt && status.measuredAt !== opts.version ? ` (nearest answer: ${status.measuredAt})` : '';
    failures.push(`  ${id}: ${status.status} on ${opts.version}${where}${detail}`);
  }
  if (failures.length) {
    throw new Error(
      `bedshock: ${failures.length} capability(s) this build rests on are not settled on ${opts.version}:\n` +
        failures.join('\n') +
        `\n\nA design resting on an unsettled capability needs a fallback, or the battery needs a run.` +
        `\nMeasured versions in the ledger: ${versionsInLedger(loaded().observations).join(', ') || 'none'}`,
    );
  }
}

/** Every capability id, for a host that wants to enumerate rather than cite. */
export function capabilityIds(): string[] {
  return loaded().catalog.capabilities.map((c) => c.id);
}

/** Drop the module-level cache. Only useful in tests and long-lived processes. */
export function reload(): void {
  cached = undefined;
}
