/**
 * Turning a server log into observations.
 *
 * Kept separate from the process that produces the log so it can be tested against a fixture,
 * and so a log captured by hand — from a client session, from a CI artifact, from somebody
 * else's machine — can be fed in with `bedshock collect`.
 *
 * TWO RULES, and they are the whole reason this is a file rather than three lines of regex.
 *
 * `LOOK` LINES ARE NOT RESULTS AND ARE NEVER RECORDED. A probe whose answer is on a screen has
 * no verdict until someone looks, and a collector that quietly graded them would let the
 * battery answer questions it never asked. They are counted and reported so a person knows
 * what is waiting for them in `bedshock amend`, and that is all.
 *
 * A LOG WITH NO `DONE` LINE IS REJECTED WHOLESALE. If the battery did not finish, the results
 * present are a prefix of a run rather than a run, and the rows that never reported are absent
 * rather than negative. Recording a partial run as a complete one is how a ledger acquires
 * confident negatives about capabilities nobody measured — which is the exact failure this
 * project exists to prevent, arriving through the back door.
 */

import type { Observation, Platform, Verdict } from './types.ts';
import type { Catalog } from './catalog.ts';

export interface CollectOptions {
  version: string;
  api?: string;
  platform?: Platform;
  run: string;
  at?: string;
}

export interface Collected {
  observations: Observation[];
  /** Capability ids the battery put on a screen. These need `bedshock amend`. */
  looks: string[];
  /** Capability ids the battery deliberately did not run, with the reason. */
  skipped: { capability: string; why: string }[];
  /** Anything wrong with the log itself. */
  problems: string[];
  /** Ids the runtime reported that the catalog does not declare. */
  unknown: string[];
  complete: boolean;
}

const RESULT = /BEDSHOCK RESULT (\S+) (YES|NO|INCONCLUSIVE) (.*)$/;
const LOOK = /BEDSHOCK LOOK (\S+) /;
const SKIP = /BEDSHOCK SKIP (\S+) (.*)$/;
const ERROR = /BEDSHOCK ERROR (\S+) (.*)$/;

export function collect(log: string, catalog: Catalog, opts: CollectOptions): Collected {
  const observations: Observation[] = [];
  const looks: string[] = [];
  const skipped: { capability: string; why: string }[] = [];
  const problems: string[] = [];
  const unknown: string[] = [];
  const at = opts.at ?? new Date().toISOString();
  const seen = new Set<string>();

  const complete = /BEDSHOCK DONE \d+/.test(log);

  for (const line of log.split('\n')) {
    const error = ERROR.exec(line);
    if (error) {
      problems.push(`probe "${error[1]}" threw: ${error[2]}`);
      continue;
    }

    const skip = SKIP.exec(line);
    if (skip) {
      skipped.push({ capability: skip[1]!, why: skip[2]!.trim() });
      continue;
    }

    const look = LOOK.exec(line);
    if (look) {
      if (!looks.includes(look[1]!)) looks.push(look[1]!);
      continue;
    }

    const match = RESULT.exec(line);
    if (!match) continue;

    const [, capability, verdict, payloadRaw] = match as unknown as [string, string, Verdict, string];
    if (!catalog.byId.has(capability)) {
      unknown.push(capability);
      continue;
    }

    // A capability reported twice in one run is a bug in the probe, not two findings. Keeping
    // the first is arbitrary; saying so is not.
    if (seen.has(capability)) {
      problems.push(`"${capability}" was reported more than once in one run — keeping the first`);
      continue;
    }
    seen.add(capability);

    let payload: { value?: number; measurement?: Record<string, unknown>; evidence?: string } = {};
    try {
      payload = JSON.parse(payloadRaw.trim() || '{}');
    } catch {
      problems.push(`"${capability}" carried a payload that is not JSON — recorded without it`);
    }

    const cap = catalog.byId.get(capability)!;
    // A solved row answered YES without a value is a probe that thinks it measured something and
    // did not. Recording it would file a convergence with nothing to compare on a later run,
    // which is the whole point of the row.
    if (cap.method === 'solved' && verdict === 'YES' && typeof payload.value !== 'number') {
      problems.push(`"${capability}" is a solved capability but reported YES with no value — dropped`);
      continue;
    }
    if (cap.method === 'observed') {
      // The runtime should never emit a RESULT for an observed row, and if it does, taking the
      // verdict at face value would be recording a guess as a measurement.
      problems.push(
        `"${capability}" is an observed capability but the battery reported a verdict for it. ` +
          `Dropped — an eyes-only row must go through \`bedshock amend\`.`,
      );
      continue;
    }

    observations.push({
      capability,
      version: opts.version,
      ...(opts.api ? { api: opts.api } : {}),
      platform: opts.platform ?? 'bds',
      method: 'automated',
      verdict,
      ...(typeof payload.value === 'number' ? { value: payload.value } : {}),
      ...(payload.measurement ? { measurement: payload.measurement } : {}),
      ...(payload.evidence ? { evidence: payload.evidence } : {}),
      run: opts.run,
      at,
    });
  }

  if (!complete) {
    problems.push(
      'the log has no "BEDSHOCK DONE" line, so the battery did not finish. Nothing is recorded: ' +
        'the rows that never reported are ABSENT, not negative, and a prefix of a run must not be ' +
        'stored as a run.',
    );
    return { observations: [], looks, skipped, problems, unknown, complete: false };
  }

  return { observations, looks, skipped, problems, unknown, complete };
}

/** The Minecraft version a Bedrock Dedicated Server log announces about itself. */
export function versionFromLog(log: string): string | undefined {
  const match = /Version[:\s]+(\d+\.\d+\.\d+(?:\.\d+)?)/i.exec(log);
  return match?.[1];
}
