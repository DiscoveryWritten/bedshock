/**
 * Harvesting reported sessions.
 *
 * The failure this file is about is not a crash. It is a batch that runs cleanly and files
 * something wrong — a code counted twice, a disagreement averaged into agreement, a stranger's
 * answer landing in the wrong version's column. None of those show up as an error; they show up
 * as a ledger that is quietly less true than it looks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatHarvest, harvest, parseReport, type Report } from './harvest.ts';
import { loadCatalog } from './catalog.ts';
import { encodeAnswers } from './anscode.ts';
import { catalogRevision } from './manifest.ts';
import { sessionQuestions } from './gen/pack.ts';
import type { Observation } from './types.ts';

const catalog = loadCatalog();
const questions = sessionQuestions(catalog);
const AT = '2026-08-04T00:00:00Z';

/** A code answering one question with a chosen outcome, as a real session would emit. */
function codeFor(index: number, outcome: number): string {
  return encodeAnswers(catalogRevision(), [{ capability: index, outcome }]);
}

function body(code: string, version = '1.21.120'): string {
  return `Answer code from a guided session:\n\ncode: ${code}\nversion: ${version}\n`;
}

const report = (issue: number, text: string, author = 'someone'): Report => ({ issue, author, body: text });

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('the code and version are read from labelled lines, not guessed out of prose', () => {
  const parsed = parseReport('code: ABCD-EFGH\nversion: 1.21.120\n');
  assert.equal(parsed.code, 'ABCDEFGH');
  assert.equal(parsed.version, '1.21.120');

  // An issue body is a free text box. Something merely code-SHAPED in a sentence must not be
  // mistaken for a report — a guess that lands here becomes a filed measurement.
  assert.equal(parseReport('I ran it and got something like ABCD-EFGH I think').code, undefined);
  assert.equal(parseReport('version 1.21 maybe?').version, undefined);
});

test('dashes and case are normalised, because a person may retype either', () => {
  assert.equal(parseReport('code: abcd-efgh\nversion: 1.21.120').code, 'ABCDEFGH');
});

// ---------------------------------------------------------------------------
// What it refuses
// ---------------------------------------------------------------------------

test('a report with no version is refused, and the refusal explains the one thing nobody can fix', () => {
  const result = harvest([report(1, `code: ${codeFor(0, 0)}\n`)], catalog, [], AT);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.why, /no Minecraft version/);
  // The reason matters: somebody reading this has to understand it is not an oversight.
  assert.match(result.rejected[0]!.why, /exposes no way to read the game build/);
});

test('a report with no code is refused', () => {
  const result = harvest([report(1, 'I did the thing! version: 1.21.120')], catalog, [], AT);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!.why, /no answer code/);
});

test('a code that will not decode is refused rather than partially recorded', () => {
  const result = harvest([report(1, body('AAAABBBBCCCC'))], catalog, [], AT);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
});

/**
 * THE POISON CASE. Outcome indices are positional, so a code produced before a question moved
 * decodes into different VALID answers — right shape, wrong questions, and nothing downstream
 * could ever tell.
 */
test('a code from a different catalog revision is refused', () => {
  const stale = encodeAnswers('rdeadbeef', [{ capability: 0, outcome: 0 }]);
  const result = harvest([report(1, body(stale))], catalog, [], AT);
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]!.why, /revision/i);
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * The same code twice is one session reported twice, not two people agreeing.
 *
 * Counting it twice manufactures confirmation out of a double tap — and confirmation is exactly
 * what a batch of strangers is supposed to be worth.
 */
test('a duplicate code is counted once', () => {
  const code = codeFor(0, 0);
  const result = harvest([report(1, body(code)), report(2, body(code), 'someone-else')], catalog, [], AT);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.duplicates, [2]);
});

// ---------------------------------------------------------------------------
// Disagreement, which is the whole point
// ---------------------------------------------------------------------------

/** Two verdicts on one row and one version is a finding, and must survive to the top of the PR. */
test('two people disagreeing on the same version is reported as a conflict', () => {
  const question = questions.findIndex((q) => (q.outcomes?.length ?? 0) >= 2);
  assert.ok(question >= 0, 'no capability has two outcomes to disagree about');
  const outcomes = questions[question]!.outcomes!;
  // Two outcomes with genuinely different verdicts, or there is nothing to disagree about.
  const a = outcomes.findIndex((o) => o.verdict !== 'INCONCLUSIVE');
  const b = outcomes.findIndex((o) => o.verdict !== 'INCONCLUSIVE' && o.verdict !== outcomes[a]!.verdict);
  if (b < 0) return; // no such pair in this catalog; the other tests still hold

  const result = harvest(
    [report(1, body(codeFor(question, a))), report(2, body(codeFor(question, b)), 'other')],
    catalog,
    [],
    AT,
  );
  assert.equal(result.accepted.length, 2);
  assert.equal(result.conflicts.length, 1, 'the disagreement was not reported');
  assert.equal(result.conflicts[0]!.verdicts.length, 2);
  assert.match(formatHarvest(result), /read these before merging/);
});

/**
 * "I could not tell" is not a dissenting opinion.
 *
 * Treating INCONCLUSIVE as a third verdict would make every hard-to-read row a permanent conflict,
 * and the conflict list is only useful while it is short enough to read.
 */
test('an inconclusive answer does not create a conflict', () => {
  const question = questions.findIndex((q) => (q.outcomes ?? []).some((o) => o.verdict === 'INCONCLUSIVE')
    && (q.outcomes ?? []).some((o) => o.verdict !== 'INCONCLUSIVE'));
  if (question < 0) return;
  const outcomes = questions[question]!.outcomes!;
  const decided = outcomes.findIndex((o) => o.verdict !== 'INCONCLUSIVE');
  const unsure = outcomes.findIndex((o) => o.verdict === 'INCONCLUSIVE');

  const result = harvest(
    [report(1, body(codeFor(question, decided))), report(2, body(codeFor(question, unsure)), 'other')],
    catalog,
    [],
    AT,
  );
  assert.equal(result.conflicts.length, 0, 'an inconclusive answer was treated as disagreement');
});

/** A stranger contradicting what is already recorded is the loudest thing this can find. */
test('contradicting the ledger is flagged as such', () => {
  const question = questions.findIndex((q) => (q.outcomes?.length ?? 0) >= 2);
  const outcomes = questions[question]!.outcomes!;
  const a = outcomes.findIndex((o) => o.verdict !== 'INCONCLUSIVE');
  const b = outcomes.findIndex((o) => o.verdict !== 'INCONCLUSIVE' && o.verdict !== outcomes[a]!.verdict);
  if (b < 0) return;

  const existing: Observation[] = [
    {
      capability: questions[question]!.id,
      version: '1.21.120',
      platform: 'client',
      method: 'observed',
      verdict: outcomes[a]!.verdict,
      outcome: outcomes[a]!.id,
      run: 'earlier',
      at: '2026-01-01T00:00:00Z',
    },
  ];

  const result = harvest([report(1, body(codeFor(question, b)))], catalog, existing, AT);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]!.contradictsLedger, true);
  assert.match(formatHarvest(result), /contradicts the ledger/);
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every observation has to say where it came from.
 *
 * A row from a stranger's phone and a row from a run somebody supervised are not the same evidence,
 * and a ledger that cannot tell them apart cannot be re-examined when one of them turns out wrong.
 */
test('a harvested observation records the issue it came from and the platform it ran on', () => {
  const result = harvest([report(42, body(codeFor(0, 0)))], catalog, [], AT);
  assert.equal(result.accepted.length, 1);
  const observation = result.accepted[0]!.observations[0]!;
  assert.equal(observation.run, 'issue-42');
  assert.equal(observation.platform, 'client');
  assert.equal(observation.version, '1.21.120');
  assert.equal(observation.at, AT);
});

test('the pull-request body names the versions and the reporters', () => {
  const text = formatHarvest(harvest([report(7, body(codeFor(0, 0)))], catalog, [], AT));
  assert.match(text, /1 session\(s\)/);
  assert.match(text, /1\.21\.120/);
  assert.match(text, /#7/);
});
