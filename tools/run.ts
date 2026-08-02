/**
 * `bedshock run` — build the pack, boot a real Bedrock server, record what it says.
 *
 * The automated half of the battery, end to end and with nobody watching. This is the part
 * that can be pointed at a Minecraft version nobody has measured yet and produce a column.
 *
 * WHAT IT WILL NOT DO. It will not record anything from a run that did not finish, and it will
 * not record anything for a capability whose answer is on a screen. Both refusals are the same
 * principle: an absent answer is not a negative one, and the cheapest way to ruin a ledger is
 * to let silence look like a finding.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { build } from './build.ts';
import { loadCatalog, type Catalog } from './catalog.ts';
import { loadPackConfig } from './config.ts';
import { collect, versionFromLog, type Collected } from './collect.ts';
import { appendObservations, assertVersion, readLedger, resolveWithDeps } from './ledger.ts';
import { BUILD_DIR, ROOT } from './paths.ts';
import type { Observation, Status } from './types.ts';

/**
 * Why the server did not report back, read out of the log rather than assumed.
 *
 * This message used to be a single hypothesis stated with confidence: "the likeliest cause is
 * the whole behavior pack being rejected over a script module pin". Which is a good guess, and
 * it is what happens most of the time — but the first time it was wrong, the log said
 * `Port [19132] may be in use` two lines above and the tool blamed the manifest anyway. Half an
 * hour went into a pin that was fine.
 *
 * That is precisely the failure this whole project is about, arriving through the error handler:
 * a confident answer to a question nobody measured. So the guess is now the LAST branch, and it
 * is labelled as a guess.
 */
const CAUSES: [RegExp, string][] = [
  [
    /Port \[(\d+)\] may be in use/,
    'the server could not bind its port — something else is already on it. Nothing here says ' +
      'anything about Bedrock or about the pack; free the port and run again.',
  ],
  [
    /Failed to (?:load|register) script|script module .* not found|Unknown module|no version of module/i,
    'the script module pin was rejected. The behavior pack loads and then does nothing, which ' +
      'looks identical to a pack with no findings. Check `script.modules` in content/pack.yaml ' +
      'against what this server build actually offers.',
  ],
  [
    /Pack Stack - \[\d+\](?!.*bedshock)[\s\S]*?Server started/i,
    'the server started without the bedshock behavior pack in its pack stack, so the battery was ' +
      'never loaded at all.',
  ],
  [/No such file or directory|Permission denied/, 'the server binary could not be run — see the log for which file.'],
];

export function diagnose(log: string): string {
  const preamble = 'A battery that did not report back measured nothing.';
  for (const [pattern, why] of CAUSES) {
    if (pattern.test(log)) return `${preamble} From the log: ${why}`;
  }
  return (
    `${preamble} Nothing in the log names a cause this tool recognises, so read it rather than ` +
    `trusting a guess. The usual culprit is the whole behavior pack being rejected over a script ` +
    `module pin, which says everything about the manifest and nothing about the game.`
  );
}

/**
 * Which probes are worth a boot on a given version, and why.
 *
 * `open`      no usable answer here. Never measured, or the apparatus failed, or two runs
 *             disagree. The obvious sweep.
 * `negative`  measured NO — **the watchlist**, and the reason this project exists at all.
 * `regress`   measured YES. A pure drift check: nothing new can come out of it except the one
 *             verdict worth interrupting for.
 *
 * THE WATCHLIST IS NOT A CURIOSITY, and treating it as one was a real bug in the first version
 * of this file: `open` excluded `CLOSED-NEGATIVE`, so a row whose answer was no would never be
 * re-asked by any narrowed sweep. That is precisely backwards. A battery for a platform that
 * changes under you is not mainly there to confirm what already works — it is there so that the
 * day something becomes possible, the test that proves it was written months ago and runs
 * without anybody deciding to look.
 *
 * So a negative is a question with a pending answer, not a closed file. `bedshock watchlist`
 * prints them with what each would unblock, and a sweep on a new Bedrock normally wants
 * `--open --negative` together: everything that is not already a confirmed yes.
 *
 * Asking for nothing asks everything — an empty list is no narrowing rather than no probes.
 */
export type Ask = 'open' | 'negative' | 'regress';

export const ALL_ASKS: Ask[] = ['open', 'negative', 'regress'];

/** Does this status answer to this reason for asking? */
export function matchesAsk(status: Status, ask: Ask): boolean {
  if (ask === 'negative') return status === 'CLOSED-NEGATIVE';
  if (ask === 'regress') return status === 'SETTLED';
  // `open` deliberately includes the states that LOOK answered and are not: an apparatus that
  // failed, a pair of runs that disagree, and a row resting on something unmeasured.
  return status === 'OPEN' || status === 'INCONCLUSIVE' || status === 'DRIFT' || status === 'UNDERMINED';
}

export function probesFor(asks: Ask[], version: string, catalog: Catalog, observations: Observation[]): string[] {
  if (asks.length === 0 || asks.length === ALL_ASKS.length) return [];
  const probes: string[] = [];
  for (const [probe, caps] of catalog.byProbe) {
    const wanted = caps.some((c) => {
      const status = resolveWithDeps(c, version, observations, catalog).status;
      return asks.some((ask) => matchesAsk(status, ask));
    });
    if (wanted) probes.push(probe);
  }
  return probes.sort();
}

export interface WatchlistEntry {
  id: string;
  question: string;
  /** What flipping this would unblock. */
  decides: string;
  measuredAt?: string;
  evidence?: string;
}

/**
 * Every row measured NO at this version: the questions whose answer we are waiting to change.
 *
 * Ordered by domain then id so the same version prints the same list twice, which matters
 * because this is a list people diff between Bedrock releases.
 */
export function watchlist(version: string, catalog: Catalog, observations: Observation[]): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const cap of catalog.capabilities) {
    if (cap.method === 'derived') continue;
    const status = resolveWithDeps(cap, version, observations, catalog);
    if (status.status !== 'CLOSED-NEGATIVE') continue;
    const top = status.observations[0];
    out.push({
      id: cap.id,
      question: cap.question,
      decides: cap.decides,
      ...(status.measuredAt ? { measuredAt: status.measuredAt } : {}),
      ...(top?.evidence ? { evidence: top.evidence } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface RunOptions {
  /** Declare the version rather than reading it out of the log. Required for a client log. */
  version?: string;
  /** Narrow the run to these reasons for asking. Any narrowing requires `version`. */
  asks?: Ask[];
  /** A specific Bedrock Dedicated Server download URL, to measure a version that is not current. */
  serverUrl?: string;
  /** Skip building — use whatever is already in `build/`. */
  noBuild?: boolean;
  /** Collect from an existing log instead of booting anything. */
  fromLog?: string;
  /** Work out what would be recorded, and record nothing. */
  dryRun?: boolean;
  /** Also package the world Minecraft generated as an importable `.mcworld` here. */
  worldOut?: string;
  /** What the world is called in a player's world list. Carries the version, so it is tellable. */
  levelName?: string;
}

export interface RunResult extends Collected {
  version: string;
  run: string;
  recorded: number;
  logPath?: string;
  /** Which probes were asked. Empty means the whole battery. */
  probes: string[];
}

function runId(): string {
  return `bds-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

export async function run(opts: RunOptions = {}): Promise<RunResult> {
  const config = loadPackConfig();
  const catalog = loadCatalog();

  let logPath = opts.fromLog;
  const asks = opts.asks ?? [];
  const narrowed = asks.length > 0 && asks.length < ALL_ASKS.length;

  if (narrowed && !opts.version) {
    throw new Error(
      `--${asks.join(' --')} needs --version. Which probes are still worth asking depends on ` +
        `which version you are asking about, and that cannot be read out of a log that does not ` +
        `exist yet.`,
    );
  }

  const probes = narrowed ? probesFor(asks, opts.version!, catalog, readLedger()) : [];

  if (narrowed && probes.length === 0) {
    throw new Error(
      `nothing on ${opts.version} matches ${asks.join(', ')}. ` +
        `Try --open --negative, which is everything that is not already a confirmed yes.`,
    );
  }

  if (!logPath) {
    if (!opts.noBuild) {
      const built = await build(config);
      for (const warning of built.warnings) process.stderr.write(`warn: ${warning}\n`);
    } else if (!existsSync(join(BUILD_DIR, 'BP', 'manifest.json'))) {
      throw new Error('--no-build was given but build/ has no pack in it');
    }

    const logDir = join(BUILD_DIR, 'logs');
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, `${runId()}.log`);

    const script = join(ROOT, 'tools', 'bds.sh');
    const result = spawnSync(
      'bash',
      [script, BUILD_DIR, logPath, ...(opts.serverUrl ? [opts.serverUrl] : [])],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          ...(probes.length ? { BEDSHOCK_PROBES: probes.join(',') } : {}),
          ...(opts.worldOut ? { BEDSHOCK_WORLD_OUT: opts.worldOut } : {}),
          ...(opts.levelName ? { BEDSHOCK_LEVEL_NAME: opts.levelName } : {}),
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `the server run failed (exit ${result.status}). Nothing has been recorded.\n` +
          `${diagnose(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')}\n` +
          `The log is at ${logPath}`,
      );
    }
  }

  const log = readFileSync(logPath, 'utf8');
  const version = opts.version ?? versionFromLog(log);
  if (!version) {
    throw new Error(
      'could not work out which Minecraft version this was. Pass --version explicitly.\n' +
        'Guessing would put an answer in the wrong column, which is worse than not recording it: ' +
        'the whole point of the ledger is which version a thing was true on.',
    );
  }
  assertVersion(version);

  const id = runId();
  const collected = collect(log, catalog, {
    version,
    api: Object.entries(config.script.modules)
      .map(([name, v]) => `${name} ${v}`)
      .join(', '),
    platform: 'bds',
    run: id,
  });

  if (!opts.dryRun) appendObservations(collected.observations);

  return {
    ...collected,
    version,
    run: id,
    probes,
    recorded: opts.dryRun ? 0 : collected.observations.length,
    ...(logPath ? { logPath } : {}),
  };
}

export function formatRunResult(result: RunResult, dryRun = false): string {
  const lines: string[] = [];
  lines.push(
    `Bedrock ${result.version} · run ${result.run}` +
      (result.probes.length ? ` · narrowed to ${result.probes.join(', ')}` : ' · full battery'),
  );
  lines.push('');

  for (const o of result.observations) {
    lines.push(`  ${o.verdict.padEnd(13)} ${o.capability}`);
    if (o.evidence) lines.push(`                ${o.evidence}`);
  }
  if (result.observations.length === 0) lines.push('  (no automated results)');
  lines.push('');

  if (result.skipped.length) {
    lines.push(`${result.skipped.length} probe(s) skipped — they need hands or eyes a server does not have:`);
    for (const s of result.skipped) lines.push(`  · ${s.capability} — ${s.why}`);
    lines.push('');
  }

  if (result.looks.length) {
    lines.push(`${result.looks.length} row(s) put something on a screen and are NOT recorded here.`);
    lines.push(`Run \`bedshock amend --version ${result.version}\` with the pack installed on a client.`);
    lines.push('');
  }

  if (result.unknown.length) {
    lines.push(`The runtime reported ${result.unknown.length} id(s) the catalog does not declare, so they were dropped:`);
    for (const id of result.unknown) lines.push(`  ! ${id}`);
    lines.push('');
  }

  if (result.problems.length) {
    lines.push('Problems with the run:');
    for (const p of result.problems) lines.push(`  ! ${p}`);
    lines.push('');
  }

  lines.push(
    dryRun
      ? `${result.observations.length} observation(s) would be recorded. Nothing was written.`
      : `${result.recorded} observation(s) appended to the ledger. Run \`bedshock report\` to rebuild the documents.`,
  );
  return lines.join('\n');
}
