/**
 * The rules that keep a question worth asking.
 *
 * Every assertion here corresponds to a way a battery can quietly stop measuring what it
 * thinks it measures. Most of them existed as prose in the document this repository grew out
 * of, and prose could not stop anybody.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog, validateCapabilities } from './catalog.ts';
import type { Capability, CapabilityFile } from './types.ts';

/**
 * Deliberately loose. Half of these tests build a capability that is INVALID — that is what
 * they are checking — so a strict parameter type here would make the malformed cases
 * unwritable and quietly reduce the suite to testing only the happy path.
 */
const base = (over: Record<string, unknown> = {}): Capability =>
  ({
    id: 'item.thing.works',
    question: 'Does the thing work?',
    decides: 'whether to build on the thing',
    method: 'automated',
    surface: 'script',
    probe: 'thing',
    ...over,
  }) as Capability;

const file = (...caps: Capability[]): CapabilityFile[] => [{ domain: 'item', capabilities: caps }];

const observed = (over: Record<string, unknown> = {}): Capability =>
  base({
    method: 'observed',
    look_at: 'the thing',
    outcomes: [
      { id: 'yes', label: 'it worked', verdict: 'YES' },
      { id: 'no', label: 'it did not', verdict: 'NO' },
      { id: 'unreadable', label: 'could not tell', verdict: 'INCONCLUSIVE' },
    ],
    ...over,
  });

test('the shipped catalog is valid', () => {
  const catalog = loadCatalog();
  assert.ok(catalog.capabilities.length > 0);
  assert.ok(catalog.byDomain.size > 0);
});

test('every capability names the decision it blocks', () => {
  const problems = validateCapabilities(file(base({ decides: undefined })));
  assert.match(problems.join('\n'), /no `decides`/);
});

test('an observed capability must enumerate its outcomes', () => {
  const problems = validateCapabilities(file(base({ method: 'observed', look_at: 'x' })));
  assert.match(problems.join('\n'), /must enumerate its `outcomes`/);
});

/**
 * The rule with the most history behind it. A rig that did not render is not a negative
 * result, and a person forced to pick a real verdict for a broken apparatus will pick one.
 */
test('an observed capability must offer an "I could not read it" answer', () => {
  const problems = validateCapabilities(
    file(
      observed({
        outcomes: [
          { id: 'yes', label: 'it worked', verdict: 'YES' },
          { id: 'no', label: 'it did not', verdict: 'NO' },
        ],
      }),
    ),
  );
  assert.match(problems.join('\n'), /INCONCLUSIVE/);
});

test('an observed capability whose outcomes cannot say NO is not measuring anything', () => {
  const problems = validateCapabilities(
    file(
      observed({
        outcomes: [
          { id: 'yes', label: 'it worked', verdict: 'YES' },
          { id: 'also_yes', label: 'it really worked', verdict: 'YES' },
          { id: 'unreadable', label: 'could not tell', verdict: 'INCONCLUSIVE' },
        ],
      }),
    ),
  );
  assert.match(problems.join('\n'), /cannot distinguish YES from NO/);
});

test('an observed capability must say what to look at', () => {
  const problems = validateCapabilities(file(observed({ look_at: undefined })));
  assert.match(problems.join('\n'), /`look_at`/);
});

test('a derived capability must say what established it, and has no probe', () => {
  assert.match(
    validateCapabilities(file(base({ method: 'derived', probe: undefined }))).join('\n'),
    /`established_by`/,
  );
  assert.match(
    validateCapabilities(file(base({ method: 'derived', established_by: 'reading the API' }))).join('\n'),
    /derived capability has no probe/,
  );
});

test('ids are dotted lower_snake and start with their domain', () => {
  assert.match(validateCapabilities(file(base({ id: 'Item.Thing' }))).join('\n'), /dotted lower_snake/);
  assert.match(validateCapabilities(file(base({ id: 'render.thing.works' }))).join('\n'), /must start with its domain/);
});

test('duplicate ids are refused', () => {
  const problems = validateCapabilities(file(base(), base()));
  assert.match(problems.join('\n'), /duplicate id/);
});

test('a dependency on something that does not exist is refused', () => {
  const problems = validateCapabilities(file(base({ depends_on: ['item.nothing.here'] })));
  assert.match(problems.join('\n'), /not a capability/);
});

test('a dependency cycle is refused', () => {
  const problems = validateCapabilities(
    file(
      base({ id: 'item.a.x', depends_on: ['item.b.x'] }),
      base({ id: 'item.b.x', depends_on: ['item.a.x'] }),
    ),
  );
  assert.match(problems.join('\n'), /dependency cycle/);
});

/**
 * A capability that carries an answer would defeat the whole arrangement: the point of keeping
 * questions and answers in different files is that a question cannot be edited into agreeing
 * with what someone wanted. Nothing in the schema accepts a verdict at the top level, and this
 * pins that the shipped catalog does not sneak one in.
 */
test('no capability definition contains an answer', () => {
  for (const cap of loadCatalog().capabilities) {
    const keys = Object.keys(cap);
    for (const forbidden of ['verdict', 'status', 'answer', 'expect', 'expect_reports']) {
      assert.ok(!keys.includes(forbidden), `${cap.id} carries "${forbidden}" — answers belong in the ledger`);
    }
  }
});

/** Dependencies are the bisect floor. A row that rests on nothing measurable is unreadable. */
test('every observed capability with a dependency depends on something that exists', () => {
  const catalog = loadCatalog();
  for (const cap of catalog.capabilities) {
    for (const dep of cap.depends_on ?? []) {
      assert.ok(catalog.byId.has(dep), `${cap.id} -> ${dep}`);
    }
  }
});
