/**
 * The manifest: one JSON file per Minecraft version, for a machine to read.
 *
 * This is the product. The Markdown report is for people; this is what another repository
 * consumes when it wants to know, before writing a line, which designs are open.
 *
 * THE REVISION, AND WHY IT IS NOT THE MINECRAFT VERSION.
 *
 * A manifest is a function of two things: the game it was measured against, and the catalog of
 * questions that were asked. The first is the Minecraft version. The second changes whenever a
 * question is added, an answer space is widened, or a probe is repaired — and when it does, the
 * SAME Minecraft version yields a DIFFERENT manifest.
 *
 * So a manifest carries both, and a release is tagged with both. `mc-1.26.36.1-r2` is the second
 * catalog revision measured against that game; `mc-1.26.36.1` moves to point at whichever is
 * newest, so a consumer pinning the bare version always gets the best answer available for the
 * game they run on. That is the "latest for that tag" the release workflow implements.
 *
 * The revision is a content hash of the catalog rather than a counter, because a counter is a
 * thing somebody has to remember to bump and a hash is a thing that cannot be wrong.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Capability, Observation, Status } from './types.ts';
import type { Catalog } from './catalog.ts';
import { resolveWithDeps, versionsInLedger } from './ledger.ts';
import { CATALOG_DIR } from './paths.ts';

export interface ManifestRow {
  id: string;
  question: string;
  decides: string;
  method: Capability['method'];
  status: Status;
  /**
   * `true` when this row's answer came from an OLDER version and was not re-checked here.
   * A consumer that cares about the difference between evidence and measurement reads this.
   */
  inherited: boolean;
  measured_on?: string;
  /** `bds` | `client` | `imported`. How much to trust it, and by what route. */
  platform?: string;
  api?: string;
  at?: string;
  evidence?: string;
  note?: string;
  measurement?: Record<string, unknown>;
  /** Which outcome a person picked, for observed rows. */
  outcome?: string;
  /** The full enumerated answer space, so a consumer can see what was distinguishable. */
  outcomes?: { id: string; label: string; verdict: string }[];
  depends_on?: string[];
  established_by?: string;
  legacy?: string;
}

export interface Manifest {
  /** Bump only on a breaking change to this shape. */
  schema: 1;
  minecraft: string;
  /** Content hash of the capability catalog these answers were produced against. */
  catalog_revision: string;
  /** `mc-<minecraft>-<catalog_revision>` — the immutable release tag for this manifest. */
  release: string;
  generated_at: string;
  counts: Record<Status | 'derived', number>;
  /**
   * Rows measured NO. Called out at the top level because it is the list a consumer most wants
   * on a new Bedrock: the things that were impossible, which is where a change is a change of
   * plan rather than a regression.
   */
  watchlist: string[];
  capabilities: ManifestRow[];
}

/**
 * A stable fingerprint of the questions.
 *
 * Hashes the raw YAML bytes rather than the parsed objects, so reordering or reformatting counts
 * as a change. That is deliberately conservative: a manifest whose revision did not move when the
 * catalog did would be a manifest a consumer could cache wrongly, and the cost of an occasional
 * spurious revision is a re-run.
 */
export function catalogRevision(dir = CATALOG_DIR): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    hash.update(name);
    hash.update(readFileSync(join(dir, name)));
  }
  return `r${hash.digest('hex').slice(0, 8)}`;
}

export function buildManifest(
  catalog: Catalog,
  observations: Observation[],
  version: string,
  now = new Date().toISOString(),
): Manifest {
  const revision = catalogRevision();
  const counts: Record<string, number> = {
    SETTLED: 0, 'CLOSED-NEGATIVE': 0, OPEN: 0, INCONCLUSIVE: 0, DRIFT: 0, UNDERMINED: 0, derived: 0,
  };

  const rows: ManifestRow[] = catalog.capabilities.map((cap) => {
    if (cap.method === 'derived') {
      counts.derived = (counts.derived ?? 0) + 1;
      return {
        id: cap.id,
        question: cap.question,
        decides: cap.decides,
        method: cap.method,
        // A derived row is established by reading what the engine does rather than by a probe.
        // It is reported as SETTLED so a consumer can build on it, and `method` says why.
        status: 'SETTLED' as Status,
        inherited: false,
        ...(cap.established_by ? { established_by: cap.established_by } : {}),
        ...(cap.depends_on ? { depends_on: cap.depends_on } : {}),
        ...(cap.legacy ? { legacy: cap.legacy } : {}),
      };
    }

    const resolved = resolveWithDeps(cap, version, observations, catalog);
    counts[resolved.status] = (counts[resolved.status] ?? 0) + 1;
    const top = resolved.observations[0];

    return {
      id: cap.id,
      question: cap.question,
      decides: cap.decides,
      method: cap.method,
      status: resolved.status,
      inherited: resolved.inherited,
      ...(resolved.measuredAt ? { measured_on: resolved.measuredAt } : {}),
      ...(top?.platform ? { platform: top.platform } : {}),
      ...(top?.api ? { api: top.api } : {}),
      ...(top?.at ? { at: top.at } : {}),
      ...(top?.evidence ? { evidence: top.evidence } : {}),
      ...(top?.note ? { note: top.note } : {}),
      ...(top?.measurement ? { measurement: top.measurement } : {}),
      ...(top?.outcome ? { outcome: top.outcome } : {}),
      ...(cap.outcomes
        ? { outcomes: cap.outcomes.map((o) => ({ id: o.id, label: o.label, verdict: o.verdict })) }
        : {}),
      ...(cap.depends_on ? { depends_on: cap.depends_on } : {}),
      ...(cap.legacy ? { legacy: cap.legacy } : {}),
    };
  });

  return {
    schema: 1,
    minecraft: version,
    catalog_revision: revision,
    release: `mc-${version}-${revision}`,
    generated_at: now,
    counts: counts as Manifest['counts'],
    watchlist: rows.filter((r) => r.status === 'CLOSED-NEGATIVE').map((r) => r.id),
    capabilities: rows,
  };
}

/**
 * What changed between two manifests.
 *
 * Diffing two manifests IS the changelog — the extraction map that preceded this repository
 * called that out, and it is right. The interesting rows are the ones that MOVED, and a flip
 * from `CLOSED-NEGATIVE` to `SETTLED` is the single most valuable line this project can produce.
 */
export interface ManifestDiff {
  from: string;
  to: string;
  became_possible: { id: string; question: string }[];
  became_impossible: { id: string; question: string }[];
  newly_answered: { id: string; status: Status }[];
  no_longer_answered: { id: string; was: Status }[];
  added: string[];
  removed: string[];
}

export function diffManifests(a: Manifest, b: Manifest): ManifestDiff {
  const before = new Map(a.capabilities.map((r) => [r.id, r]));
  const after = new Map(b.capabilities.map((r) => [r.id, r]));
  const diff: ManifestDiff = {
    from: `${a.minecraft} (${a.catalog_revision})`,
    to: `${b.minecraft} (${b.catalog_revision})`,
    became_possible: [],
    became_impossible: [],
    newly_answered: [],
    no_longer_answered: [],
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
  };

  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was || was.status === now.status) continue;
    if (was.status === 'CLOSED-NEGATIVE' && now.status === 'SETTLED') {
      diff.became_possible.push({ id, question: now.question });
    } else if (was.status === 'SETTLED' && now.status === 'CLOSED-NEGATIVE') {
      diff.became_impossible.push({ id, question: now.question });
    } else if (was.status === 'OPEN' && now.status !== 'OPEN') {
      diff.newly_answered.push({ id, status: now.status });
    } else if (now.status === 'OPEN' || now.status === 'INCONCLUSIVE') {
      diff.no_longer_answered.push({ id, was: was.status });
    }
  }
  return diff;
}

export function manifestVersions(observations: Observation[]): string[] {
  return versionsInLedger(observations);
}
