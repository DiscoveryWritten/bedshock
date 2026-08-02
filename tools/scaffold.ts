/**
 * `bedshock init` — a working catalog, probe and ledger of your own, in one command.
 *
 * WHY THIS IS A COMMAND AND NOT A PARAGRAPH IN THE README. Every data path in this repository is
 * already overridable, so a project that vendors bedshock can point `BEDSHOCK_CATALOG` and
 * `BEDSHOCK_LEDGER` at its own files and get the whole apparatus — the search, the ledger, the
 * drift detection, the report with its log scale — running on questions we have never heard of.
 * That has been true for a while and nobody would ever have found it out, because the distance
 * between "is possible" and "somebody did it" is entirely made of blank files.
 *
 * WHAT IT IS FOR. bedshock's catalog is about Bedrock. It cannot contain the questions that
 * matter most to a specific project, because those are about that project's own code:
 *
 *   - how much upward boost a horizontal portal has to give to clear the floor on exit
 *   - the speed above which something crossing a trigger volume is never seen inside it
 *   - how many entities a per-tick scan survives before the frame budget goes
 *
 * Every one of those is a boundary found by asking a yes/no trial repeatedly, which is exactly
 * what this apparatus does. Keeping them out of our catalog and giving people the machine is a
 * better trade than absorbing them: the questions stay where the code is, and the answers still
 * come out as a versioned artifact with concrete numbers in it.
 *
 * WHAT IT WRITES is deliberately small and deliberately RUNS. A scaffold that needs editing
 * before `validate` passes teaches its first lesson by failing, and the lesson is "this is
 * fiddly". So the example row is complete, the example probe compiles against the harness, and
 * `bedshock validate` passes on the output before a single line is changed.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ScaffoldOptions {
  /** Where the files go. */
  dir: string;
  /** The domain, which is also the file name and the first segment of every id. */
  domain: string;
  /** Relative path from the consumer's pack sources to their bedshock checkout. */
  bedshock: string;
}

export interface Scaffolded {
  written: string[];
  skipped: string[];
}

export function scaffold(opts: ScaffoldOptions): Scaffolded {
  const domain = opts.domain.replace(/[^a-z0-9_]/g, '_').toLowerCase();
  const files: [string, string][] = [
    [join('capabilities', `${domain}.yaml`), catalogFile(domain)],
    [join('probes', `${domain}.ts`), probeFile(domain, opts.bedshock)],
    ['observations.jsonl', ''],
    ['README.md', readme(domain, opts.dir)],
  ];

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [name, body] of files) {
    const path = join(opts.dir, name);
    // Never overwrite. The most likely second run of this command is a mistake, and the most
    // likely thing to lose is a ledger — which is append-only precisely because the answers in
    // it cannot be re-derived from anything.
    if (existsSync(path)) {
      skipped.push(path);
      continue;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    written.push(path);
  }
  return { written, skipped };
}

// ---------------------------------------------------------------------------

function catalogFile(domain: string): string {
  return `# Your questions. One file per domain; the domain is the first segment of every id here.
#
# THE ONE RULE THAT MATTERS: a capability is one proposition with one verdict, and the verdict
# has a lifetime of its own. "Does the portal work" is not a capability -- it is a feature, and
# when it breaks nobody can tell you which part stopped being true. "Does an entity moving faster
# than N blocks a tick get seen inside a one-block trigger volume" is a capability: it has one
# answer, the answer can change when Bedrock changes, and knowing it changed tells you exactly
# what to go and look at.
#
# \`solved\` rows are the ones with numbers. Everything about them is in the header of
# docs/SOLVING.md in the bedshock checkout; the short version is that a solve needs a trial, a
# range, and a tolerance taken from your instrument's own resolution rather than from how precise
# you would like to be.

domain: ${domain}
about: >-
  What this group of questions is about, in a sentence somebody who did not write it can read.

capabilities:
  - id: ${domain}.example.threshold
    question: >-
      Replace this. State the question as something with one answer -- if you cannot say what a
      NO would look like, it is not a capability yet.
    decides: >-
      What you would build differently depending on the answer. A row that decides nothing is a
      row nobody re-runs, and a number nobody re-runs is a number that quietly goes stale.
    method: solved
    # engine  -- base game behaviour; moves when Bedrock does
    # script  -- an API contract; moves when you raise your module pin
    # content -- something your own pack declares; moves when you change it
    surface: engine
    probe: ${domain}
    measures:
      unit: blocks
      # minimum -- the smallest value that still works
      # maximum -- the largest
      direction: maximum
      # From your apparatus's resolution. Movement inside it is not a finding, and a tolerance
      # finer than the instrument reports drift on noise until people stop reading the report.
      tolerance: 0.5
      # Both ends are TESTED before the search starts. If the property fails at the loose end or
      # holds at the tight end, the solve reports INCONCLUSIVE instead of converging on a bound
      # and calling the edge of your search a measurement.
      search: { from: 0, to: 16 }
    notes: >-
      Say what the tolerance is derived from. Future you will want to know whether a number that
      moved by 0.4 moved because the game changed or because the probe is coarse.
`;
}

function probeFile(domain: string, bedshock: string): string {
  const harness = `${bedshock.replace(/\/+$/, '')}/pack/scripts/harness.ts`;
  return `/**
 * The trial. This is the part only you can write.
 *
 * \`solve\` decides WHICH value to try and when to stop; your job is to answer, for one value,
 * whether the property held. It may take as many ticks as it needs -- just call \`settle\` exactly
 * once when you know.
 *
 * THREE THINGS TO GET RIGHT, and each of them is the difference between a measurement and a
 * number that merely looks like one:
 *
 *   CLEAN UP FIRST, NOT LAST. Start every trial by putting the world back. A trial that inherits
 *   the last one's leftovers measures both.
 *
 *   \`settle(null)\` WHEN THE APPARATUS FAILED. The entity never spawned, the chunk went away,
 *   something threw. That is not the property failing, and reporting it as \`false\` feeds the
 *   search a fabricated result -- which it will happily converge on.
 *
 *   MAKE BOTH BOUNDS REACHABLE. \`solve\` tests the ends of your range before it searches, and
 *   refuses to run if the trial fails at the loose end or holds at the tight one. That check is
 *   the only thing standing between a broken trial and a confident-looking number, so give it
 *   ends that genuinely differ.
 */

import { world } from '@minecraft/server';

import { solve, type Ctx, type Settle } from '${harness}';

const CAPABILITY = '${domain}.example.threshold';

export function run(ctx: Ctx): void {
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');

  const trial = (x: number, settle: Settle): void => {
    try {
      // Set up, do the thing at \`x\`, decide whether it held.
      //
      // If it takes ticks, start a \`system.runInterval\` here and call \`settle\` from inside it.
      // If you do, nothing else is needed -- \`solve\` has already claimed the completion wait, so
      // your row cannot vanish from the log by finishing after the battery says DONE.
      void dimension;
      settle(x <= 4, \`replace this with what actually happened at \${x}\`);
    } catch (err) {
      settle(null, String(err).split('\\n')[0]);
    }
  };

  solve(
    ctx,
    {
      capability: CAPABILITY,
      probe: '${domain}',
      unit: 'blocks',
      direction: 'maximum',
      from: 0,
      to: 16,
      tolerance: 0.5,
      // Hold every time or you did not hold. Raise it when the trial is noisy; the question is
      // almost always whether the thing works RELIABLY at that value.
      repeats: 2,
      cooldown: 10,
    },
    trial,
  );
}
`;
}

function readme(domain: string, dir: string): string {
  const here = relative(process.cwd(), dir) || '.';
  return `# Capability questions for this project

These are ours, not bedshock's. bedshock's catalog is about what Bedrock can do; this one is
about what THIS code can do on top of it. The apparatus is shared, the questions are not.

## Running it

Point bedshock at these files and every command works on them:

    export BEDSHOCK_CATALOG=${here}/capabilities
    export BEDSHOCK_LEDGER=${here}/observations.jsonl
    export BEDSHOCK_DOCS=${here}/report

    npx tsx <bedshock>/tools/cli.ts validate     # the questions, checked against the answers
    npx tsx <bedshock>/tools/cli.ts run          # measure, on a real server
    npx tsx <bedshock>/tools/cli.ts report       # a versioned report with the numbers in it
    npx tsx <bedshock>/tools/cli.ts export --out manifest.json

\`export\` is the artifact. It is a manifest keyed by Minecraft version with every answer and
every measured value in it, and \`bedshock diff a.json b.json\` between two of them is a
changelog nobody wrote: what became possible, what stopped working, and which numbers moved
under code that still runs.

## The probe

\`probes/${domain}.ts\` is a starting point, and it is deliberately the only file here you have
to think hard about. Wire it into your own behaviour pack's script entry point the way you wire
in anything else — bedshock does not build your pack, it reads the log your pack writes.

## Adding a question

One proposition, one verdict, one lifetime. If you cannot say what a NO would look like, it is
not a capability yet — it is a feature, and when it breaks the report will not be able to tell
you which part stopped being true.
`;
}
