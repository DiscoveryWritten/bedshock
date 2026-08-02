#!/usr/bin/env -S npx tsx
/**
 * The bedshock command line.
 *
 *   validate                    check the questions and the ledger against each other
 *   build                       emit the probe pack
 *   run                         build, boot a real server, record the automated answers
 *   collect <log>               record from a log captured elsewhere
 *   amend                       answer the eyes-only rows, from what you saw in play
 *   report                      regenerate docs/ from the ledger
 *   check                       fail a build that rests on an unsettled capability
 *   status [capability]         what the ledger says, without regenerating anything
 *   tidy                        sort the ledger file (never alters a line)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import { amend } from './amend.ts';
import { build } from './build.ts';
import { loadCatalog } from './catalog.ts';
import { checkCitations, collectCitations, formatCheckResult } from './check.ts';
import { collect } from './collect.ts';
import { loadPackConfig } from './config.ts';
import {
  appendObservations, latestVersion, readLedger, resolveWithDeps, tidyLedger, validateLedger, versionsInLedger,
} from './ledger.ts';
import { writeReports } from './report.ts';
import { buildManifest, catalogRevision, diffManifests, type Manifest } from './manifest.ts';
import { formatRedeem, redeem } from './redeem.ts';
import { ALL_ASKS, formatRunResult, run, watchlist, type Ask } from './run.ts';
import type { Platform } from './types.ts';

interface Args {
  _: string[];
  [flag: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [flag, inline] = token.slice(2).split('=', 2);
    const next = argv[i + 1];
    if (inline !== undefined) args[flag!] = inline;
    else if (next && !next.startsWith('--')) {
      args[flag!] = next;
      i++;
    } else args[flag!] = true;
  }
  return args;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').map((s) => s.trim()) : []);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';

  switch (command) {
    // -----------------------------------------------------------------------
    case 'validate': {
      // Loading throws on any structural problem, which is most of the check.
      const catalog = loadCatalog();
      loadPackConfig();
      const observations = readLedger();
      const problems = validateLedger(observations, catalog);
      if (problems.length) {
        fail(`the ledger disagrees with the catalog:\n  ${problems.join('\n  ')}`);
      }
      process.stdout.write(
        `${catalog.capabilities.length} capabilities across ${catalog.byDomain.size} domains, ` +
          `${observations.length} observations across ${versionsInLedger(observations).length} version(s). ` +
          `All consistent.\n`,
      );
      break;
    }

    // -----------------------------------------------------------------------
    case 'build': {
      const result = await build();
      for (const warning of result.warnings) process.stderr.write(`\nwarn: ${warning}\n`);
      process.stdout.write(`\n${result.files} files -> ${result.addon}\n`);
      break;
    }

    // -----------------------------------------------------------------------
    case 'run': {
      const asks: Ask[] = [
        ...(args.open ? ['open' as const] : []),
        ...(args.negative ? ['negative' as const] : []),
        ...(args.regress ? ['regress' as const] : []),
        ...(list(args.ask).filter((a): a is Ask => ALL_ASKS.includes(a as Ask))),
      ];
      const result = await run({
        asks: [...new Set(asks)],
        ...(str(args.version) ? { version: str(args.version)! } : {}),
        ...(str(args['server-url']) ? { serverUrl: str(args['server-url'])! } : {}),
        ...(str(args['from-log']) ? { fromLog: str(args['from-log'])! } : {}),
        ...(args['no-build'] ? { noBuild: true } : {}),
        ...(args['dry-run'] ? { dryRun: true } : {}),
        ...(str(args['world-out']) ? { worldOut: str(args['world-out'])! } : {}),
        ...(str(args['level-name']) ? { levelName: str(args['level-name'])! } : {}),
      });
      process.stdout.write(`\n${formatRunResult(result, Boolean(args['dry-run']))}\n`);
      if (!args['dry-run'] && result.recorded > 0) writeReports(loadCatalog(), readLedger());
      break;
    }

    // -----------------------------------------------------------------------
    case 'collect': {
      const path = args._[1] ?? fail('usage: bedshock collect <log> --version <v> [--platform client]');
      const version = str(args.version) ?? fail('--version is required: a result in the wrong column is worse than none');
      const catalog = loadCatalog();
      const result = collect(readFileSync(path, 'utf8'), catalog, {
        version,
        platform: (str(args.platform) as Platform) ?? 'imported',
        run: str(args.run) ?? `import-${new Date().toISOString().slice(0, 10)}`,
        ...(str(args.api) ? { api: str(args.api)! } : {}),
      });
      for (const p of result.problems) process.stderr.write(`! ${p}\n`);
      if (!args['dry-run']) appendObservations(result.observations);
      process.stdout.write(
        `${result.observations.length} observation(s)${args['dry-run'] ? ' would be' : ''} recorded from ${path}.\n` +
          (result.looks.length ? `${result.looks.length} row(s) still need eyes — see \`bedshock amend\`.\n` : ''),
      );
      break;
    }

    // -----------------------------------------------------------------------
    case 'amend': {
      const catalog = loadCatalog();
      const version =
        str(args.version) ??
        latestVersion(readLedger()) ??
        fail('--version is required: nothing in the ledger says which Bedrock you are looking at');
      const recorded = await amend(catalog, {
        version,
        ...(str(args.api) ? { api: str(args.api)! } : {}),
        platform: (str(args.platform) as Platform) ?? 'client',
        ...(list(args.probe).length ? { probes: list(args.probe) } : {}),
        ...(str(args.capability) ? { capability: str(args.capability)! } : {}),
        ...(args.all ? { all: true } : {}),
        ...(args.negative ? { negative: true } : {}),
      });
      if (recorded.length) writeReports(catalog, readLedger());
      break;
    }

    // -----------------------------------------------------------------------
    case 'report': {
      const catalog = loadCatalog();
      const written = writeReports(catalog, readLedger());
      process.stdout.write(`${written.map((w) => `  ${w}`).join('\n')}\n`);
      break;
    }

    // -----------------------------------------------------------------------
    case 'check': {
      const patterns = list(args['requires-from']);
      if (!patterns.length) {
        fail(
          'usage: bedshock check --requires-from "src/**/*.ts" --version 1.21.120\n' +
            'A check with no patterns matches nothing and reports success forever, which is why ' +
            'this is an error rather than a default.',
        );
      }
      const version = str(args.version) ?? fail('--version is required — usually the pack\'s own min_engine_version');
      const citations = await collectCitations(patterns, str(args.cwd) ?? process.cwd());
      const result = checkCitations(citations, loadCatalog(), readLedger(), version);
      process.stdout.write(`${formatCheckResult(result, version)}\n`);
      if (!result.ok) process.exit(1);
      break;
    }

    // -----------------------------------------------------------------------
    case 'status': {
      const catalog = loadCatalog();
      const observations = readLedger();
      const version = str(args.version) ?? latestVersion(observations) ?? fail('the ledger is empty');
      const only = args._[1];
      const caps = only ? catalog.capabilities.filter((c) => c.id.startsWith(only)) : catalog.capabilities;
      if (!caps.length) fail(`nothing matches "${only}"`);
      process.stdout.write(`\nBedrock ${version}\n\n`);
      for (const cap of caps) {
        if (cap.method === 'derived') {
          process.stdout.write(`  ${'derived'.padEnd(16)} ${cap.id}\n`);
          continue;
        }
        const s = resolveWithDeps(cap, version, observations, catalog);
        const suffix = s.inherited ? ` (from ${s.measuredAt})` : s.conflict ? ` — ${s.conflict}` : '';
        process.stdout.write(`  ${s.status.padEnd(16)} ${cap.id}${suffix}\n`);
      }
      process.stdout.write('\n');
      break;
    }

    // -----------------------------------------------------------------------
    // Bare, newline-free, for `$(...)` in a shell. Everything else this CLI prints is for a
    // person, and a script parsing prose is a script that breaks on a wording change.
    case 'latest-version': {
      const version = latestVersion(readLedger());
      if (!version) fail('the ledger is empty');
      process.stdout.write(version!);
      break;
    }

    // -----------------------------------------------------------------------
    case 'export': {
      const catalog = loadCatalog();
      const observations = readLedger();
      const version = str(args.version) ?? latestVersion(observations) ?? fail('the ledger is empty');
      const manifest = buildManifest(catalog, observations, version);
      const out = str(args.out);
      const json = JSON.stringify(manifest, null, 2) + '\n';
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, json);
        process.stderr.write(`${manifest.release} -> ${out}\n`);
      } else {
        process.stdout.write(json);
      }
      break;
    }

    // -----------------------------------------------------------------------
    case 'diff': {
      const a = args._[1] ?? fail('usage: bedshock diff <a.json> <b.json>');
      const b = args._[2] ?? fail('usage: bedshock diff <a.json> <b.json>');
      const load = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;
      const d = diffManifests(load(a), load(b));
      process.stdout.write(`\n${d.from}  ->  ${d.to}\n\n`);
      if (d.values_moved.length) {
        process.stdout.write(`VALUES MOVED (${d.values_moved.length}) — the numbers shifted under something that still works:\n`);
        for (const r of d.values_moved) {
          const delta = r.to - r.from;
          process.stdout.write(
            `  ~ ${r.id}\n      ${r.from} -> ${r.to} ${r.unit ?? ''}` +
              ` (${delta > 0 ? '+' : ''}${delta.toFixed(4)}, tolerance ${r.tolerance ?? '—'})\n`,
          );
        }
        process.stdout.write('\n');
      }
      if (d.became_possible.length) {
        process.stdout.write(`BECAME POSSIBLE (${d.became_possible.length}) — the line this project exists to print:\n`);
        for (const r of d.became_possible) process.stdout.write(`  + ${r.id}\n      ${r.question.replace(/\s+/g, ' ')}\n`);
        process.stdout.write('\n');
      }
      if (d.became_impossible.length) {
        process.stdout.write(`BECAME IMPOSSIBLE (${d.became_impossible.length}) — something that worked no longer does:\n`);
        for (const r of d.became_impossible) process.stdout.write(`  - ${r.id}\n      ${r.question.replace(/\s+/g, ' ')}\n`);
        process.stdout.write('\n');
      }
      for (const [label, rows] of [
        ['newly answered', d.newly_answered.map((r) => `${r.id} -> ${r.status}`)],
        ['no longer answered', d.no_longer_answered.map((r) => `${r.id} (was ${r.was})`)],
        ['added to the catalog', d.added],
        ['removed from the catalog', d.removed],
      ] as [string, string[]][]) {
        if (!rows.length) continue;
        process.stdout.write(`${label} (${rows.length}):\n`);
        for (const r of rows) process.stdout.write(`  ${r}\n`);
        process.stdout.write('\n');
      }
      const moved =
        d.values_moved.length + d.became_possible.length + d.became_impossible.length +
        d.newly_answered.length + d.no_longer_answered.length + d.added.length + d.removed.length;
      if (moved === 0) process.stdout.write('Nothing moved.\n\n');
      break;
    }

    // -----------------------------------------------------------------------
    // The other end of the only channel a Minecraft client has.
    case 'redeem': {
      const code = args._.slice(1).join(' ') || str(args.code);
      if (!code) fail('usage: bedshock redeem <code> --version <v>');
      const catalog = loadCatalog();
      const version =
        str(args.version) ??
        fail(
          '--version is required. The code says WHAT you saw; only you know which Bedrock you ' +
            'saw it on, and a result in the wrong column is worse than no result.',
        );
      const result = redeem(code!, catalog, {
        version,
        platform: (str(args.platform) as Platform) ?? 'client',
        ...(str(args.api) ? { api: str(args.api)! } : {}),
        ...(str(args.note) ? { notes: { [str(args.capability) ?? '']: str(args.note)! } } : {}),
      });
      process.stdout.write(`${formatRedeem(result, version, Boolean(args['dry-run']))}\n`);
      if (result.problems.length && result.observations.length === 0) process.exit(1);
      if (!args['dry-run'] && result.observations.length) {
        appendObservations(result.observations);
        writeReports(catalog, readLedger());
      }
      break;
    }

    // -----------------------------------------------------------------------
    case 'watchlist': {
      const catalog = loadCatalog();
      const observations = readLedger();
      const version = str(args.version) ?? latestVersion(observations) ?? fail('the ledger is empty');
      const rows = watchlist(version, catalog, observations);
      if (rows.length === 0) {
        process.stdout.write(`\nNothing is measured NO on ${version}.\n\n`);
        break;
      }
      process.stdout.write(
        `\n${rows.length} capability(s) measured NO on Bedrock ${version}.\n` +
          `These are questions with a pending answer, not closed files — re-ask them on any ` +
          `Bedrock\nyou have not looked at yet:\n\n` +
          `  bedshock run --open --negative --version <new>\n` +
          `  bedshock amend --version <new> --negative\n\n`,
      );
      for (const row of rows) {
        process.stdout.write(`  ${row.id}${row.measuredAt !== version ? `  (measured ${row.measuredAt})` : ''}\n`);
        process.stdout.write(`    ${row.question.replace(/\s+/g, ' ').trim()}\n`);
        process.stdout.write(`    would unblock: ${row.decides.replace(/\s+/g, ' ').trim().slice(0, 150)}\n\n`);
      }
      break;
    }

    // -----------------------------------------------------------------------
    case 'tidy': {
      const n = tidyLedger();
      process.stdout.write(`${n} observations, sorted. No line altered.\n`);
      break;
    }

    // -----------------------------------------------------------------------
    default:
      process.stdout.write(
        [
          'bedshock — what Bedrock can actually do, measured, per version.',
          '',
          '  validate                          the questions and the ledger, checked against each other',
          '  build                             emit the probe pack -> dist/*.mcaddon',
          '  run [--version v] [--server-url u] [--from-log f] [--dry-run]',
          '      [--world-out f.mcworld] [--level-name n]  also package an importable world',
          '                                    build, boot a real server, record the automated answers',
          '                                    --open     only what this version has no answer for',
          '                                    --negative only what is measured NO — the watchlist',
          '                                    --regress  only what is settled — a drift check',
          '  collect <log> --version v         record from a log captured elsewhere',
          '  amend [--version v] [--probe p]   answer the eyes-only rows from what you saw in play',
          '  redeem <code> --version v         record a guided session\'s answer code',
          '  report                            regenerate docs/ from the ledger',
          '  check --requires-from <glob> --version v',
          '                                    fail a build that rests on an unsettled capability',
          '  status [prefix] [--version v]     what the ledger says right now',
          '  watchlist [--version v]           every row measured NO, and what flipping it unblocks',
          '  export [--version v] [--out f]    the machine-readable manifest a consumer reads',
          '  diff <a.json> <b.json>            what moved between two manifests',
          '  latest-version                    the newest version in the ledger, bare, for scripts',
          '  tidy                              sort the ledger file (never alters a line)',
          '',
        ].join('\n'),
      );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
