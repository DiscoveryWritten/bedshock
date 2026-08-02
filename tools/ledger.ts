/**
 * The ledger: append-only observations, and the rollup that turns them into statuses.
 *
 * JSONL rather than YAML, and append-only rather than editable, for one reason: the failure
 * this repository exists to prevent is a recorded answer being quietly adjusted to match what
 * someone wanted. There is no `status: SETTLED` field anywhere in this system. A status is a
 * function of observations, so the only way to change one is to add a measurement — and the
 * old measurement stays visible next to the new one.
 *
 * One line per (capability, version, run). Sorted on write so the file diffs cleanly, but
 * never rewritten: a line that is already committed is history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Capability, CapabilityStatus, Observation, Status } from './types.ts';
import type { Catalog } from './catalog.ts';
import { LEDGER_FILE } from './paths.ts';

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Compare two Bedrock versions. `1.21.120` sorts above `1.21.20`, which a string compare
 * gets backwards and which is exactly the range this project lives in.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(\.\d+)?$/;

export function assertVersion(version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a Bedrock version — expected something like 1.21.120`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export function readLedger(file = LEDGER_FILE): Observation[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line, i) => {
      try {
        return JSON.parse(line) as Observation;
      } catch {
        throw new Error(`${file}:${i + 1} is not valid JSON`);
      }
    });
}

export function appendObservations(observations: Observation[], file = LEDGER_FILE): void {
  if (observations.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const lines = observations.map((o) => JSON.stringify(orderKeys(o))).join('\n');
  appendFileSync(file, existsSync(file) && readFileSync(file, 'utf8').endsWith('\n') ? `${lines}\n` : `\n${lines}\n`);
}

/** Stable key order, so two runs that record the same thing produce identical bytes. */
function orderKeys(o: Observation): Observation {
  const {
    capability, version, api, platform, method, verdict, outcome, measurement, evidence, note, run, at,
  } = o;
  const out: Record<string, unknown> = { capability, version, platform, method, verdict };
  if (api !== undefined) out.api = api;
  if (outcome !== undefined) out.outcome = outcome;
  if (measurement !== undefined) out.measurement = measurement;
  if (evidence !== undefined) out.evidence = evidence;
  if (note !== undefined) out.note = note;
  out.run = run;
  out.at = at;
  return out as unknown as Observation;
}

export function validateLedger(observations: Observation[], catalog: Catalog): string[] {
  const problems: string[] = [];
  observations.forEach((o, i) => {
    const where = `observation ${i + 1} (${o.capability ?? '<none>'} @ ${o.version ?? '<none>'})`;
    const cap = catalog.byId.get(o.capability);
    if (!cap) {
      problems.push(`${where}: no such capability`);
      return;
    }
    if (!o.version || !VERSION_PATTERN.test(o.version)) problems.push(`${where}: bad version`);
    if (!['YES', 'NO', 'INCONCLUSIVE'].includes(o.verdict)) problems.push(`${where}: bad verdict "${o.verdict}"`);
    if (!o.run) problems.push(`${where}: no run id`);
    if (!o.at || Number.isNaN(Date.parse(o.at))) problems.push(`${where}: no valid timestamp`);
    if (cap.method === 'observed') {
      if (!o.outcome) {
        problems.push(`${where}: an observed capability must record which outcome was picked`);
      } else {
        const declared = cap.outcomes?.find((x) => x.id === o.outcome);
        if (!declared) {
          problems.push(`${where}: outcome "${o.outcome}" is not one this capability declares`);
        } else if (declared.verdict !== o.verdict) {
          // The one edit that would make this whole system worthless: an answer whose recorded
          // verdict does not match what the outcome it was picked from means. Cheap to check,
          // and impossible to notice by reading.
          problems.push(
            `${where}: outcome "${o.outcome}" means ${declared.verdict}, but the observation says ${o.verdict}`,
          );
        }
      }
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// The rollup
// ---------------------------------------------------------------------------

function verdictToStatus(verdict: string): Status {
  if (verdict === 'YES') return 'SETTLED';
  if (verdict === 'NO') return 'CLOSED-NEGATIVE';
  return 'INCONCLUSIVE';
}

/**
 * What one capability is on one version, from the observations recorded at exactly that
 * version. No inheritance — see `resolve` for the version-walking form.
 *
 * DRIFT is the interesting case and it is narrow on purpose: two observations at the SAME
 * version disagreeing. That is either the game changing under a version number or a probe
 * edited into lying, and both are worth stopping for. A disagreement across two DIFFERENT
 * versions is not drift, it is the finding this whole repository is built to capture — the
 * moment something became possible.
 */
export function statusAt(cap: Capability, version: string, observations: Observation[]): CapabilityStatus {
  const mine = observations
    .filter((o) => o.capability === cap.id && o.version === version)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  if (mine.length === 0) {
    return { capability: cap, version, status: 'OPEN', observations: [] };
  }

  // Only runs that could decide. An INCONCLUSIVE run reports that the APPARATUS failed, which
  // is a statement about the probe rather than about the game — so it neither settles a row nor
  // unsettles one that a good run already answered. A later broken run does not retract an
  // earlier good measurement; it just means the instrument needs fixing before the row can be
  // re-checked. The inconclusive observation stays visible in the list either way.
  const decisive = mine.filter((o) => o.verdict !== 'INCONCLUSIVE');
  let status = decisive.length > 0 ? verdictToStatus(decisive[0]!.verdict) : 'INCONCLUSIVE';
  let conflict: string | undefined;
  if (decisive.length > 1) {
    const verdicts = new Set(decisive.map((o) => o.verdict));
    if (verdicts.size > 1) {
      status = 'DRIFT';
      const [newest, ...older] = decisive;
      conflict =
        `${newest!.verdict} on ${newest!.at.slice(0, 10)} (run ${newest!.run}), ` +
        `but ${older.map((o) => `${o.verdict} on ${o.at.slice(0, 10)}`).join(', ')} — ` +
        `same version, different answers`;
    } else if (status === 'SETTLED' || status === 'CLOSED-NEGATIVE') {
      // Same verdict, different numbers underneath it. The durability ceilings are why this
      // exists: every declared value reporting itself is a YES either way, and a change from
      // "32768 wraps to -32768" to "32768 clamps to 32767" would keep that YES while
      // invalidating the design it was measured for.
      const shape = (o: Observation): string => JSON.stringify(o.measurement ?? null);
      const newest = decisive[0]!;
      const differing = decisive.slice(1).find((o) => shape(o) !== shape(newest));
      if (differing && newest.measurement !== undefined && differing.measurement !== undefined) {
        status = 'DRIFT';
        conflict =
          `same verdict, different measurement: ${shape(newest)} on ${newest.at.slice(0, 10)} ` +
          `vs ${shape(differing)} on ${differing.at.slice(0, 10)}`;
      }
    }
  }

  return { capability: cap, version, status, observations: mine, ...(conflict ? { conflict } : {}) };
}

export interface Resolved extends CapabilityStatus {
  /** The version the answer actually came from, which may be below the one asked about. */
  measuredAt?: string;
  /** True when nothing was measured at the requested version and an older one was used. */
  inherited: boolean;
}

/**
 * What a capability is on a version, walking DOWN to the newest version that has an answer.
 *
 * Inheritance downward and never upward, and the asymmetry is the point. A capability
 * measured on 1.21.120 is the best evidence available for 1.21.130 — patch versions rarely
 * remove things, and if one does, the drift check on a later run is what says so. But a
 * capability measured on 1.26.30 says nothing whatsoever about 1.21.120: the newer engine is
 * exactly where a thing that did not used to work starts working, and treating a new API as
 * evidence about an old client is the mistake that ships a pack which loads for nobody.
 *
 * So `bedshock check` against a pack's `min_engine_version` can only ever be satisfied by a
 * measurement at or below that floor.
 */
export function resolve(cap: Capability, version: string, observations: Observation[]): Resolved {
  const exact = statusAt(cap, version, observations);
  if (exact.status !== 'OPEN') return { ...exact, measuredAt: version, inherited: false };

  const below = [
    ...new Set(
      observations
        .filter((o) => o.capability === cap.id && compareVersions(o.version, version) < 0)
        .map((o) => o.version),
    ),
  ].sort(compareVersions);

  const nearest = below.pop();
  if (!nearest) return { ...exact, inherited: false };

  const inheritedStatus = statusAt(cap, nearest, observations);
  return { ...inheritedStatus, version, measuredAt: nearest, inherited: true };
}

/**
 * The same, plus the dependency check.
 *
 * A capability settled downstream of an open one is `UNDERMINED`: the rig may have rendered
 * perfectly and still measured the instrument rather than the game. This is the bisect floor
 * made mechanical — the host repo learned it by spending a session on a P3b rig that could
 * not say whether attachables worked on custom items at all, then added P3a underneath it.
 */
export function resolveWithDeps(
  cap: Capability,
  version: string,
  observations: Observation[],
  catalog: Catalog,
): Resolved {
  const own = resolve(cap, version, observations);
  if (own.status !== 'SETTLED' && own.status !== 'CLOSED-NEGATIVE') return own;

  for (const depId of cap.depends_on ?? []) {
    const dep = catalog.byId.get(depId);
    if (!dep) continue;
    const depStatus = resolve(dep, version, observations);
    if (depStatus.status === 'SETTLED') continue;
    return {
      ...own,
      status: 'UNDERMINED',
      conflict: `rests on ${depId}, which is ${depStatus.status} on ${version}`,
    };
  }
  return own;
}

/** Every version any observation mentions, oldest first. */
export function versionsInLedger(observations: Observation[]): string[] {
  return [...new Set(observations.map((o) => o.version))].sort(compareVersions);
}

export function latestVersion(observations: Observation[]): string | undefined {
  return versionsInLedger(observations).pop();
}

/**
 * Sort the ledger file by (capability, version, timestamp) without dropping or altering a
 * line. Purely cosmetic — it keeps diffs readable when several runs land out of order — and
 * deliberately the only write path other than append.
 */
export function tidyLedger(file = LEDGER_FILE): number {
  const observations = readLedger(file);
  observations.sort(
    (a, b) =>
      a.capability.localeCompare(b.capability) ||
      compareVersions(a.version, b.version) ||
      Date.parse(a.at) - Date.parse(b.at),
  );
  writeFileSync(file, observations.map((o) => JSON.stringify(orderKeys(o))).join('\n') + '\n');
  return observations.length;
}
