/**
 * `bedshock redeem <code>` — turning a session's answer code back into observations.
 *
 * The other end of the only channel a Minecraft client has. A person ran the guided session on
 * whatever device they play on, read twenty-odd characters off the screen, and handed them over.
 * This is where those become measurements.
 *
 * EVERY REFUSAL HERE IS THE SAME REFUSAL. A code that will not decode costs one re-read. A code
 * that decodes to the *wrong answers* puts fabricated measurements into an append-only ledger
 * that other repositories build on, and nothing downstream could ever tell. So:
 *
 *   - the checksum must match, and a mismatch is never "close enough";
 *   - the catalog revision must match, because outcome indices are POSITIONAL and a question
 *     edited since the session was run has moved them;
 *   - every index must resolve to a capability and an outcome that actually exist;
 *   - the verdict recorded is the one the outcome DECLARES, never one supplied alongside it.
 *
 * The last is worth spelling out: the code carries which button was pressed, not what it meant.
 * Meaning is looked up in the catalog at redeem time, so a code cannot assert a verdict its
 * outcome does not have.
 */

import type { Observation, Platform } from './types.ts';
import type { Catalog } from './catalog.ts';
import { decodeAnswers } from './anscode.ts';
import { sessionQuestions } from './gen/pack.ts';
import { catalogRevision } from './manifest.ts';
import { assertVersion } from './ledger.ts';

export interface RedeemOptions {
  version: string;
  api?: string;
  platform?: Platform;
  run?: string;
  at?: string;
  /** Notes keyed by capability id, for anything the buttons could not carry. */
  notes?: Record<string, string>;
}

export interface RedeemResult {
  observations: Observation[];
  problems: string[];
  /** Human-readable, one line per answer, for confirming before anything is written. */
  lines: string[];
}

export function redeem(code: string, catalog: Catalog, opts: RedeemOptions): RedeemResult {
  assertVersion(opts.version);
  const problems: string[] = [];
  const lines: string[] = [];

  const decoded = decodeAnswers(code);
  if (!decoded.ok || !decoded.payload) {
    return { observations: [], problems: [decoded.error ?? 'the code could not be read'], lines };
  }

  const expected = catalogRevision().replace(/^r/, '').slice(0, 4).toUpperCase();
  if (decoded.payload.revision !== expected) {
    return {
      observations: [],
      lines,
      problems: [
        `this code was produced against catalog revision ${decoded.payload.revision}, and this ` +
          `checkout is ${expected}.\n` +
          `The answers are positional — a question added, removed or reordered since that session ` +
          `has moved every index after it, so redeeming this here would file answers against the ` +
          `wrong questions.\n` +
          `Check out the revision the session ran against, or re-run the session on this one.`,
      ],
    };
  }

  const questions = sessionQuestions(catalog);
  const at = opts.at ?? new Date().toISOString();
  const run = opts.run ?? `session-${at.replace(/[-:]/g, '').replace(/\..*$/, 'Z')}`;
  const observations: Observation[] = [];
  const seen = new Set<number>();

  for (const answer of decoded.payload.answers) {
    const cap = questions[answer.capability];
    if (!cap) {
      problems.push(`capability index ${answer.capability} is not in this catalog`);
      continue;
    }
    // A session asks each question once. A repeat means a corrupted code that happened to
    // checksum, which is unlikely enough to be worth shouting about rather than tolerating.
    if (seen.has(answer.capability)) {
      problems.push(`${cap.id} appears twice in this code — it will not be recorded`);
      continue;
    }
    seen.add(answer.capability);

    const outcome = cap.outcomes?.[answer.outcome];
    if (!outcome) {
      problems.push(`${cap.id} has no outcome at index ${answer.outcome}`);
      continue;
    }

    observations.push({
      capability: cap.id,
      version: opts.version,
      ...(opts.api ? { api: opts.api } : {}),
      platform: opts.platform ?? 'client',
      method: 'observed',
      // The catalog decides what the button meant. The code only says which button.
      verdict: outcome.verdict,
      outcome: outcome.id,
      evidence: outcome.label,
      ...(opts.notes?.[cap.id] ? { note: opts.notes[cap.id]! } : {}),
      run,
      at,
    });

    lines.push(`  ${outcome.verdict.padEnd(13)} ${cap.id}\n                ${outcome.label}`);
  }

  return { observations, problems, lines };
}

export function formatRedeem(result: RedeemResult, version: string, dryRun: boolean): string {
  const out: string[] = [];
  if (result.problems.length) {
    out.push('');
    for (const problem of result.problems) out.push(`! ${problem}`);
    out.push('');
  }
  if (result.observations.length === 0) {
    out.push('Nothing recorded.');
    return out.join('\n');
  }
  out.push('', `Bedrock ${version} — ${result.observations.length} answer(s) from a guided session:`, '');
  out.push(...result.lines);
  out.push('');
  out.push(
    dryRun
      ? 'Nothing was written. Drop --dry-run to record.'
      : `${result.observations.length} observation(s) appended. Run \`bedshock report\` to rebuild the documents.`,
  );
  return out.join('\n');
}
