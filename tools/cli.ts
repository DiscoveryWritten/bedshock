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

import { readFileSync } from 'node:fs';
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
import { formatRunResult, run } from './run.ts';
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
      const scope = args.open ? 'open' : args.regress ? 'regress' : 'all';
      const result = await run({
        scope,
        ...(str(args.version) ? { version: str(args.version)! } : {}),
        ...(str(args['server-url']) ? { serverUrl: str(args['server-url'])! } : {}),
        ...(args['no-build'] ? { noBuild: true } : {}),
        ...(args['dry-run'] ? { dryRun: true } : {}),
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
          '  run [--version v] [--server-url u] [--open|--regress] [--dry-run]',
          '                                    build, boot a real server, record the automated answers',
          '                                    --open    only what this version has no answer for',
          '                                    --regress only what is settled — a pure drift check',
          '  collect <log> --version v         record from a log captured elsewhere',
          '  amend [--version v] [--probe p]   answer the eyes-only rows from what you saw in play',
          '  report                            regenerate docs/ from the ledger',
          '  check --requires-from <glob> --version v',
          '                                    fail a build that rests on an unsettled capability',
          '  status [prefix] [--version v]     what the ledger says right now',
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
