/**
 * Turning reported sessions into a pull request.
 *
 * A stranger scans the QR their session built, lands on the page, taps "Send it in", and an issue
 * appears carrying their answer code. This is what happens next.
 *
 * IT OPENS A PULL REQUEST AND NEVER PUSHES. An observation is history, and history should not
 * arrive by merge from a person nobody has met. That is the same rule the scheduled sweep follows
 * for its own measurements, and it matters more here rather than less: these come from devices we
 * do not control, running builds we may not have, reported by people with no stake in the answer
 * being right.
 *
 * WHAT MAKES A BATCH OF STRANGERS WORTH MORE THAN ONE CAREFUL RUN, and it is not volume for its
 * own sake:
 *
 *   THE VERSION AXIS FILLS ITSELF. The ledger has the versions somebody here installed. A hundred
 *   players are on builds nobody here will ever install, including ones already superseded — and
 *   a capability's history is exactly the thing that cannot be measured retroactively.
 *
 *   DISAGREEMENT IS THE FINDING. Two people on the SAME version answering a row differently is
 *   not noise to be averaged away. It is either a device difference, a reading nobody could make
 *   reliably, or a question that is worse than it looks — and all three are worth knowing. So
 *   conflicts are reported at the top of the pull request rather than resolved by counting.
 *
 * WHAT IT REFUSES, and every refusal says why on the issue rather than going quiet:
 *
 *   A CODE THAT WILL NOT DECODE costs one re-read. `redeem` handles it.
 *   A STALE CATALOG REVISION is the poison case: outcome indices are positional, so a code from
 *   before a question moved decodes into DIFFERENT VALID ANSWERS. Nothing downstream could tell.
 *   NO MINECRAFT VERSION is fatal and unavoidable. `@minecraft/server` exposes no way to read the
 *   game's build, so the pack genuinely cannot stamp it — only the person can, which is why the
 *   report page asks before it will build the link.
 */

import type { Catalog } from './catalog.ts';
import type { Observation } from './types.ts';
import { redeem } from './redeem.ts';
import { resolve } from './ledger.ts';

/** One reported session, as it arrives from the issue tracker. */
export interface Report {
  issue: number;
  author: string;
  body: string;
}

export interface Accepted {
  issue: number;
  author: string;
  version: string;
  observations: Observation[];
}

export interface Rejected {
  issue: number;
  author: string;
  why: string;
}

/**
 * The same capability answered differently, on the same version, by different people.
 *
 * NOT resolved here, and not by majority. Three people saying yes and one saying no on one Bedrock
 * build is a fact about that row's readability, and flattening it to "yes" discards the only
 * evidence that the question is hard to answer.
 */
export interface Conflict {
  capability: string;
  version: string;
  verdicts: { verdict: string; issues: number[] }[];
  /** Whether one of the disagreeing sides is already in the ledger. */
  contradictsLedger: boolean;
}

export interface Harvest {
  accepted: Accepted[];
  rejected: Rejected[];
  conflicts: Conflict[];
  /** Codes seen more than once across the batch, kept only the first time. */
  duplicates: number[];
}

/**
 * The block the report page writes, and the only thing parsed out of an issue body.
 *
 * A FENCED, LABELLED BLOCK rather than prose, because an issue body is a text box a person can
 * type anything into — including a sentence that happens to contain something code-shaped. Parsing
 * loosely here would mean guessing, and a guess that lands produces a filed measurement.
 */
const CODE = /^\s*code:\s*([0-9A-Za-z-]{8,})\s*$/im;
const VERSION = /^\s*version:\s*(\d+\.\d+\.\d+(?:\.\d+)?)\s*$/im;

export function parseReport(body: string): { code?: string; version?: string } {
  const code = CODE.exec(body)?.[1];
  const version = VERSION.exec(body)?.[1];
  return {
    ...(code ? { code: code.replace(/-/g, '').toUpperCase() } : {}),
    ...(version ? { version } : {}),
  };
}

export function harvest(reports: Report[], catalog: Catalog, ledger: Observation[], at: string): Harvest {
  const accepted: Accepted[] = [];
  const rejected: Rejected[] = [];
  const duplicates: number[] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    const { code, version } = parseReport(report.body);

    if (!code) {
      rejected.push({
        issue: report.issue,
        author: report.author,
        why:
          'no answer code found. The report page writes a line reading `code: ...` — if this was ' +
          'typed by hand, add one.',
      });
      continue;
    }

    if (!version) {
      rejected.push({
        issue: report.issue,
        author: report.author,
        why:
          'no Minecraft version. This is the one thing the pack cannot work out for itself — the ' +
          'script API exposes no way to read the game build — and an answer filed against the ' +
          'wrong version is worse than no answer. Add a line reading `version: 1.21.120`, which ' +
          'is on the game\'s main menu.',
      });
      continue;
    }

    // A code repeated across the batch is one session reported twice, not two sessions agreeing.
    // Counting it twice would manufacture confirmation out of a double tap.
    if (seen.has(code)) {
      duplicates.push(report.issue);
      continue;
    }
    seen.add(code);

    let result;
    try {
      result = redeem(code, catalog, {
        version,
        platform: 'client',
        run: `issue-${report.issue}`,
        at,
      });
    } catch (err) {
      rejected.push({ issue: report.issue, author: report.author, why: String(err).split('\n')[0] ?? 'unknown' });
      continue;
    }

    if (result.observations.length === 0) {
      rejected.push({
        issue: report.issue,
        author: report.author,
        why: result.problems.join('\n') || 'the code carried no answers',
      });
      continue;
    }

    accepted.push({ issue: report.issue, author: report.author, version, observations: result.observations });
  }

  return { accepted, rejected, conflicts: findConflicts(accepted, catalog, ledger), duplicates };
}

/**
 * Where the batch disagrees with itself, or with what is already recorded.
 *
 * Keyed by capability AND version, because the same row answering differently on two Bedrock
 * builds is not a conflict at all — it is the entire point of the version axis, and calling it a
 * disagreement would bury the finding this repository exists to surface.
 */
function findConflicts(accepted: Accepted[], catalog: Catalog, ledger: Observation[]): Conflict[] {
  const byRow = new Map<string, Map<string, number[]>>();

  for (const entry of accepted) {
    for (const observation of entry.observations) {
      const key = `${observation.capability}@${observation.version}`;
      const verdicts = byRow.get(key) ?? new Map<string, number[]>();
      verdicts.set(observation.verdict, [...(verdicts.get(observation.verdict) ?? []), entry.issue]);
      byRow.set(key, verdicts);
    }
  }

  const conflicts: Conflict[] = [];
  for (const [key, verdicts] of byRow) {
    const [capability, version] = key.split('@') as [string, string];
    // INCONCLUSIVE is not a dissenting verdict. Somebody who could not tell disagrees with
    // nobody, and treating "I could not see it" as a third opinion would turn every hard-to-read
    // row into a permanent conflict.
    const decided = [...verdicts].filter(([verdict]) => verdict !== 'INCONCLUSIVE');

    const cap = catalog.byId.get(capability);
    const already = cap ? resolve(cap, version, ledger) : undefined;
    // The RECORDED VERDICT, not the derived status. `SETTLED` and `CLOSED-NEGATIVE` are rollups
    // over a history; what a new answer can contradict is the observation itself. Most recent
    // first, and an inherited answer from an older version is deliberately included -- a stranger
    // on this build disagreeing with what an older build showed is exactly the drift worth seeing.
    const recorded = already?.observations[0]?.verdict;
    const contradictsLedger =
      decided.length > 0 && recorded !== undefined && decided.some(([verdict]) => verdict !== recorded);

    if (decided.length > 1 || contradictsLedger) {
      conflicts.push({
        capability,
        version,
        verdicts: decided.map(([verdict, issues]) => ({ verdict, issues })),
        contradictsLedger,
      });
    }
  }
  return conflicts;
}

/** The pull-request body, and the summary a person actually reads before merging. */
export function formatHarvest(result: Harvest): string {
  const lines: string[] = [];
  const sessions = result.accepted.length;
  const rows = result.accepted.reduce((sum, a) => sum + a.observations.length, 0);
  const versions = [...new Set(result.accepted.map((a) => a.version))].sort();

  lines.push(`${sessions} session(s) from ${new Set(result.accepted.map((a) => a.author)).size} reporter(s), ${rows} observation(s).`);
  if (versions.length) lines.push(`Versions: ${versions.join(', ')}`);
  lines.push('');

  // CONFLICTS FIRST. They are the reason to read this rather than merge it, and putting them under
  // a long list of accepted rows is how they get scrolled past.
  if (result.conflicts.length) {
    lines.push(`## ${result.conflicts.length} disagreement(s) — read these before merging`);
    lines.push('');
    lines.push('Same row, same Bedrock build, different answers. That is a finding, not noise:');
    lines.push('either the devices differ, or the question cannot be answered reliably.');
    lines.push('');
    for (const conflict of result.conflicts) {
      const spread = conflict.verdicts.map((v) => `**${v.verdict}** (${v.issues.map((i) => `#${i}`).join(', ')})`).join(' vs ');
      lines.push(`- \`${conflict.capability}\` on **${conflict.version}** — ${spread}` +
        (conflict.contradictsLedger ? ' — **and this contradicts the ledger**' : ''));
    }
    lines.push('');
  }

  if (result.accepted.length) {
    lines.push('## Accepted');
    lines.push('');
    for (const entry of result.accepted) {
      lines.push(`- #${entry.issue} — ${entry.observations.length} row(s) on ${entry.version}`);
    }
    lines.push('');
  }

  if (result.duplicates.length) {
    lines.push(`## Duplicates, skipped`);
    lines.push('');
    lines.push(`The same code arrived more than once. Counted once — a double tap is not two sessions agreeing.`);
    lines.push('');
    for (const issue of result.duplicates) lines.push(`- #${issue}`);
    lines.push('');
  }

  if (result.rejected.length) {
    lines.push('## Not recorded');
    lines.push('');
    for (const entry of result.rejected) {
      lines.push(`- #${entry.issue} — ${entry.why.split('\n')[0]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
