/**
 * The answer code, which is the only way results leave a Minecraft client.
 *
 * `@minecraft/server-net` is Bedrock-Dedicated-Server only, so a client add-on has no network at
 * all. On a device with no terminal beside it the code IS the transport, read off a screen by a
 * person. Every test here is about the two ways that can go wrong: a code that will not decode,
 * which costs a re-read, and a code that decodes to the WRONG answers, which puts measurements
 * nobody made into an append-only ledger other repositories build on.
 *
 * Only the second one matters, and it is the one that cannot be noticed downstream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeAnswers, encodeAnswers, MAX_CAPABILITIES, MAX_OUTCOMES, type Answer } from './anscode.ts';
import { loadCatalog } from './catalog.ts';
import { sessionQuestions } from './gen/pack.ts';
import { catalogRevision } from './manifest.ts';
import { redeem } from './redeem.ts';

const catalog = loadCatalog();
const REV = catalogRevision();
const V = '1.26.36.1';

test('a code round trips exactly', () => {
  const answers: Answer[] = [
    { capability: 0, outcome: 0 },
    { capability: 7, outcome: 3 },
    { capability: 21, outcome: 1 },
  ];
  const decoded = decodeAnswers(encodeAnswers(REV, answers));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.payload!.answers, answers);
  assert.equal(decoded.payload!.revision, REV.replace(/^r/, '').slice(0, 4).toUpperCase());
});

test('the boundary values survive', () => {
  const answers: Answer[] = [
    { capability: 0, outcome: 0 },
    { capability: MAX_CAPABILITIES - 1, outcome: MAX_OUTCOMES - 1 },
  ];
  assert.deepEqual(decodeAnswers(encodeAnswers(REV, answers)).payload!.answers, answers);
});

test('a code is short enough to read off a screen', () => {
  const answers = Array.from({ length: 12 }, (_, i) => ({ capability: i, outcome: i % 4 }));
  const code = encodeAnswers(REV, answers);
  // Twelve answers in under fifty characters, grouped in fours. The alternative this replaces is
  // typing twelve sentences into a different device.
  assert.ok(code.length < 50, `a 12-answer code is ${code.length} characters`);
  assert.match(code, /^[0-9A-Z-]+$/);
});

test('the alphabet excludes everything a person confuses on a screen', () => {
  const code = encodeAnswers(REV, Array.from({ length: 40 }, (_, i) => ({ capability: i, outcome: 5 })));
  for (const ch of 'ILOU') {
    assert.ok(!code.includes(ch), `"${ch}" is in the alphabet and is confusable`);
  }
});

// ---------------------------------------------------------------------------
// Reading it back wrong
// ---------------------------------------------------------------------------

/** The one that matters. A wrong character must never produce different valid answers. */
test('a single mistyped character is refused', () => {
  const code = encodeAnswers(REV, [
    { capability: 3, outcome: 1 },
    { capability: 9, outcome: 2 },
    { capability: 14, outcome: 0 },
  ]);
  const chars = [...code.replace(/-/g, '')];
  let checked = 0;
  for (let i = 0; i < chars.length; i++) {
    const swapped = [...chars];
    swapped[i] = swapped[i] === 'Z' ? 'Y' : 'Z';
    const result = decodeAnswers(swapped.join(''));
    // Either it is refused, or — for a corruption the checksum cannot see — it must at least not
    // silently claim to be the same answers.
    if (result.ok) {
      assert.notDeepEqual(result.payload!.answers, decodeAnswers(code).payload!.answers, `position ${i}`);
    }
    checked++;
  }
  assert.ok(checked > 10);
});

/** Two characters swapped is the other mistake a person makes, and a plain sum would miss it. */
test('two adjacent characters swapped is refused', () => {
  const code = encodeAnswers(REV, [
    { capability: 2, outcome: 3 },
    { capability: 11, outcome: 1 },
    { capability: 19, outcome: 2 },
  ]).replace(/-/g, '');
  let refusals = 0;
  let compared = 0;
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] === code[i + 1]) continue;
    const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
    compared++;
    if (!decodeAnswers(swapped).ok) refusals++;
  }
  assert.ok(compared > 5);
  assert.equal(refusals, compared, `${compared - refusals} transposition(s) decoded anyway`);
});

test('dashes, spacing and case are all forgiven', () => {
  const answers: Answer[] = [{ capability: 5, outcome: 2 }, { capability: 8, outcome: 1 }];
  const code = encodeAnswers(REV, answers);
  for (const variant of [code.toLowerCase(), code.replace(/-/g, ''), code.replace(/-/g, ' '), ` ${code} `]) {
    const decoded = decodeAnswers(variant);
    assert.equal(decoded.ok, true, `"${variant}" was refused`);
    assert.deepEqual(decoded.payload!.answers, answers);
  }
});

/** A touch keyboard produces these, and they are unambiguous in this alphabet. */
test('O for zero and I or L for one are corrected rather than refused', () => {
  const answers: Answer[] = [{ capability: 0, outcome: 1 }, { capability: 16, outcome: 0 }];
  const code = encodeAnswers(REV, answers);
  const mangled = code.replace(/0/g, 'O').replace(/1/g, 'l');
  const decoded = decodeAnswers(mangled);
  assert.equal(decoded.ok, true, decoded.error);
  assert.deepEqual(decoded.payload!.answers, answers);
});

test('nonsense is refused rather than parsed', () => {
  for (const bad of ['', 'hello', '----', 'ZZ']) {
    assert.equal(decodeAnswers(bad).ok, false, `"${bad}" decoded`);
  }
});

// ---------------------------------------------------------------------------
// Redeeming
// ---------------------------------------------------------------------------

test('redeeming records the verdict the CATALOG declares, not one carried in the code', () => {
  const questions = sessionQuestions(catalog);
  const index = questions.findIndex((q) => (q.outcomes ?? []).some((o) => o.verdict === 'NO'));
  const question = questions[index]!;
  const outcomeIndex = question.outcomes!.findIndex((o) => o.verdict === 'NO');

  const result = redeem(encodeAnswers(REV, [{ capability: index, outcome: outcomeIndex }]), catalog, {
    version: V,
    at: '2026-08-02T00:00:00Z',
  });

  assert.deepEqual(result.problems, []);
  assert.equal(result.observations.length, 1);
  const observation = result.observations[0]!;
  assert.equal(observation.capability, question.id);
  assert.equal(observation.verdict, 'NO');
  assert.equal(observation.outcome, question.outcomes![outcomeIndex]!.id);
  assert.equal(observation.method, 'observed');
  assert.equal(observation.platform, 'client');
  assert.equal(observation.version, V);
});

/**
 * Outcome indices are positional. A question added, removed or reordered since the session moves
 * every index after it, so a code from another revision would file answers against the wrong
 * questions — silently, and with a valid checksum.
 */
test('a code from another catalog revision is refused', () => {
  const code = encodeAnswers('rdeadbeef', [{ capability: 0, outcome: 0 }]);
  const result = redeem(code, catalog, { version: V });
  assert.equal(result.observations.length, 0);
  assert.match(result.problems.join('\n'), /positional/);
});

test('an index that resolves to nothing is reported rather than dropped', () => {
  const questions = sessionQuestions(catalog);
  const result = redeem(
    encodeAnswers(REV, [
      { capability: questions.length + 5, outcome: 0 },
      { capability: 0, outcome: MAX_OUTCOMES - 1 },
    ]),
    catalog,
    { version: V },
  );
  assert.equal(result.observations.length, 0);
  assert.equal(result.problems.length, 2);
  assert.match(result.problems.join('\n'), /not in this catalog/);
  assert.match(result.problems.join('\n'), /no outcome at index/);
});

test('the same capability twice is refused rather than recorded twice', () => {
  const result = redeem(
    encodeAnswers(REV, [{ capability: 0, outcome: 0 }, { capability: 0, outcome: 1 }]),
    catalog,
    { version: V },
  );
  assert.equal(result.observations.length, 1);
  assert.match(result.problems.join('\n'), /appears twice/);
});

/**
 * The whole loop, end to end: the ordering the PACK embeds has to be the ordering the redeemer
 * reconstructs, or every answer lands on the wrong question. Both derive it from the catalog by
 * sorting on id, and nothing else is shared between them.
 */
test('the session ordering the pack embeds is the ordering redeem reconstructs', () => {
  const questions = sessionQuestions(catalog);
  const answers = questions.slice(0, 6).map((q, i) => ({ capability: i, outcome: 0 }));
  const result = redeem(encodeAnswers(REV, answers), catalog, { version: V });
  assert.deepEqual(
    result.observations.map((o) => o.capability),
    questions.slice(0, 6).map((q) => q.id),
  );
});
