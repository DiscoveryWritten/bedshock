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
import type { Observation } from './types.ts';

/**
 * Which probes are worth a boot on a given version.
 *
 * `all`     the whole battery. What you want on a version nobody has touched.
 * `open`    only probes carrying a capability this version has no usable answer for. The
 *           "has it become possible yet?" sweep — cheap enough to run against every new
 *           Bedrock, which is the point of writing a test for a capability before it exists.
 * `regress` only probes whose capabilities are ALL already settled here. Pure drift check:
 *           nothing new can come out of it except the one thing worth interrupting for.
 *
 * Both narrowed modes need the version stated up front, because the selection depends on it.
 * That is a real constraint rather than an oversight: you cannot ask "what is still open on
 * this version" of a log that has not been written yet.
 */
export type Scope = 'all' | 'open' | 'regress';

export function probesFor(scope: Scope, version: string, catalog: Catalog, observations: Observation[]): string[] {
  if (scope === 'all') return [];
  const probes: string[] = [];
  for (const [probe, caps] of catalog.byProbe) {
    const settled = caps.map((c) => resolveWithDeps(c, version, observations, catalog).status);
    const anyUnanswered = settled.some((s) => s !== 'SETTLED' && s !== 'CLOSED-NEGATIVE');
    if (scope === 'open' ? anyUnanswered : !anyUnanswered) probes.push(probe);
  }
  return probes.sort();
}

export interface RunOptions {
  /** Declare the version rather than reading it out of the log. Required for a client log. */
  version?: string;
  /** Narrow the run. `open` and `regress` require `version`. */
  scope?: Scope;
  /** A specific Bedrock Dedicated Server download URL, to measure a version that is not current. */
  serverUrl?: string;
  /** Skip building — use whatever is already in `build/`. */
  noBuild?: boolean;
  /** Collect from an existing log instead of booting anything. */
  fromLog?: string;
  /** Work out what would be recorded, and record nothing. */
  dryRun?: boolean;
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
  const scope: Scope = opts.scope ?? 'all';

  if (scope !== 'all' && !opts.version) {
    throw new Error(
      `--${scope} needs --version. Which probes are still worth asking depends on which version ` +
        `you are asking about, and that cannot be read out of a log that does not exist yet.`,
    );
  }

  const probes =
    scope === 'all' ? [] : probesFor(scope, opts.version!, catalog, readLedger());

  if (scope !== 'all' && probes.length === 0) {
    throw new Error(
      scope === 'open'
        ? `nothing is open on ${opts.version} — every probe's capabilities already have an answer there.`
        : `nothing is settled on ${opts.version} yet, so there is nothing to re-check for drift.`,
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
        env: { ...process.env, ...(probes.length ? { BEDSHOCK_PROBES: probes.join(',') } : {}) },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `the server run failed (exit ${result.status}). Nothing has been recorded.\n` +
          `A battery that did not report back measured nothing — the likeliest cause is the whole ` +
          `behavior pack being rejected over a script module pin, which says everything about the ` +
          `manifest and nothing about the game. The log is at ${logPath}`,
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
