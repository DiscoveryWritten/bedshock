# Solving

How to measure a number instead of a yes, and how to do it with questions this repository has
never heard of.

---

## The two halves of a capability battery

bedshock's catalog is about Bedrock: what the game can do, per version, measured. That is one
half, and it is the half that generalises — everyone building on Bedrock needs the same answers,
so measuring them once and publishing a manifest is worth doing.

The other half does not generalise at all, and it is usually the half that decides whether
something ships:

- how much upward boost a horizontal portal has to give to clear the floor on the way out
- the speed above which something crossing a one-block trigger volume is never seen inside it
- how many entities a per-tick scan survives before the frame budget goes

Those are not questions about Bedrock. They are questions about one project's own code, and they
have no business in a shared catalog. But they are the *same kind* of question: a boundary, found
by asking a yes/no trial repeatedly at different values, worth recording per Minecraft version
because the answer moves when the engine moves underneath it.

So the apparatus is the part worth sharing. **You bring the questions and the trial; this brings
the search, the box to run it in, the ledger, the drift detection, and the report.**

| | |
|---|---|
| `solve` | A **boundary**. Your trial answers yes/no at a value; this bisects it. |
| `measure` | A **measurement**. Your apparatus hands back a number; this takes several and reports what they agree on. |
| `arena` | A box to measure in — flat, empty, carved, and *verified* — so a short throw is not confused with a wall. |
| `bisect` / `summarise` | The same two, with no Minecraft in them, for measuring in memory. |

```
bedshock init capabilities --domain portals --bedshock ../vendor/bedshock
```

writes a catalog, a probe and an empty ledger that already validate, and

```
export BEDSHOCK_CATALOG=capabilities/capabilities
export BEDSHOCK_LEDGER=capabilities/observations.jsonl
export BEDSHOCK_DOCS=capabilities/report
```

makes every command in this repository work on your questions instead of ours. Your `export`
produces your own manifest with its own release tag; your `diff` between two of them is a
changelog nobody wrote.

---

## What a `solved` row is

A normal capability asks whether something is possible and gets `YES` or `NO`. A `solved` one
asks **how much** and gets a number.

The distinction earns its keep on the day nothing appears to have changed. A yes/no row only
reports when something starts or stops working. A solved row reports when the game's constants
shift underneath a design that still runs, still passes, and is now quietly wrong by 15%. Nothing
else in a test suite notices that, and it is the failure most likely to survive a release.

### Two shapes, and picking the wrong one wastes a probe

**A boundary.** Your apparatus can only tell you *whether* something worked. "Can a block get out
of the way this late?" has no number in it — you ask it repeatedly at different values and the
edge between yes and no is the answer. That is `solve`, and `anvilgap` is the worked example.

**A measurement.** Your apparatus hands you a number every time. "How far did the item go?" is
already the answer; the only question is whether several of them agree. That is `measure`, and
`throw` and `knockback` are the worked examples.

Nothing in a type will catch the wrong choice. Forcing a measurement through a bisection burns
dozens of trials and throws away the number it had all along; forcing a boundary through a
measurement asks an apparatus for a figure it cannot produce. Both compile, both run, and both
show up only as a strange result on a real server — so `bedshock test` pins which tool each probe
imports.

Both end in the same place: one value, one tolerance, one row that reports when a constant moves.
A report cannot tell which was used and does not need to.

```yaml
- id: physics.falling_block.min_clearance_under_a_falling_anvil
  question: How far above a falling anvil can a block vacate its path and still be clear?
  decides: The tightest a pass-under mechanic can be built before it becomes unreliable.
  method: solved
  surface: engine
  probe: anvilgap
  measures:
    unit: blocks
    direction: maximum          # the LARGEST value that still holds
    tolerance: 0.6              # one tick of travel — see below
    search: { from: 0, to: 8 }
```

The row and the instrument live in two files on purpose. The **range, direction, unit and
tolerance** belong to the question — they say what is being measured and how finely the answer
means anything — so they sit in the catalog. **Repeats, timings, block choices** belong to the
instrument and sit in `content/pack.yaml`. Neither file can see the other, and the runtime reads
the question's half from the generated catalog rather than restating it, so a probe cannot search
a range the catalog does not describe.

### Tolerance is the instrument, not the ambition

Set it from what your apparatus can actually resolve.

A tolerance finer than the instrument reports `DRIFT` on noise forever, and a drift report people
learn to ignore is worse than no drift report at all. The anvil row above uses 0.6 blocks because
a falling anvil only exists at tick-spaced positions, and by the time it reaches the plane it
covers about that much per tick. Nothing finer is a fact about Bedrock.

Say where the number came from, in `notes`. Future you will want to know whether a value that
moved by 0.4 moved because the game changed or because the probe is coarse.

---

## Writing a trial

```ts
import { solve, type Ctx, type Settle } from '../vendor/bedshock/pack/scripts/harness.ts';

export function run(ctx: Ctx): void {
  const trial = (x: number, settle: Settle): void => {
    // set up, do the thing at x, decide whether it held
    settle(held);
  };

  solve(ctx, {
    capability: 'portals.exit.min_boost_to_clear_the_floor',
    probe: 'portals',
    unit: 'blocks_per_tick',
    direction: 'minimum',
    from: 0, to: 2, tolerance: 0.05,
    repeats: 3,
  }, trial);
}
```

`solve` decides which value to try and when to stop. Your job is to answer, for one value,
whether the property held. It may take as many ticks as it needs — start a `system.runInterval`
and call `settle` from inside it. You do not need to claim the completion wait; `solve` already
did, so your row cannot vanish from the log by finishing after the battery printed `DONE`.

### Three things to get right

**Clean up first, not last.** Start every trial by putting the world back. A trial that inherits
the previous one's leftovers measures both of them.

**`settle(null)` when the apparatus failed.** The entity never spawned, the chunk went away,
something threw. That is not the property failing. Reporting it as `false` feeds the search a
fabricated result, and a search will converge on a fabricated result exactly as confidently as on
a real one.

**Make both bounds genuinely differ.** `solve` tests the ends of your range before it searches,
and refuses to run if the trial fails at the loose end or holds at the tight one. That check is
the only thing standing between a broken trial and a plausible number, so do not give it a range
where both ends behave the same way.

### Repeats are conjunctive

`repeats: 3` means the trial must hold three times out of three. The question a solve asks is
almost always whether something works *reliably* at that value, and a single lucky tick alignment
is not a design anyone can build on. A failure short-circuits the rest, so the cost is well under
three times the trials.

---

## Writing a measurement

```ts
import { arena, measure, type Ctx, type Record } from '../vendor/bedshock/pack/scripts/harness.ts';

export function run(ctx: Ctx): void {
  const box = arena(ctx.player!.location, { length: 24, height: 4, width: 1 });

  const reading = (index: number, record: Record): void => {
    box.clear();
    const problem = box.verify();
    if (problem) return record(null, problem);   // the arena is missing: not a reading of zero
    // ... do the thing, then record the number
  };

  measure(ctx, {
    capability: 'portals.exit.boost_needed_to_clear_the_floor',
    probe: 'portals',
    unit: 'blocks',
    samples: 5,
    spread: 0.5,
    range: { from: 0, to: 24 },
  }, reading);
}
```

`record(null)` is not a reading of zero. Zero is a perfectly good measurement; `null` means this
reading did not happen, and collapsing the two puts a fabricated number in the set that the
median then treats as data.

### The value is the median, never the mean

One reading down a ravine should not move the answer at all. With five samples a mean lets it
move the answer by a fifth of the error, which is exactly enough to be wrong and not enough to be
obvious.

### `spread` is not `tolerance`, and the difference is checked

**Tolerance** is how far the *answer* may move between runs before it is a finding. It belongs to
the question, and lives in the catalog.

**Spread** is how far one *reading* may scatter within a run. It belongs to the instrument, and
lives in `content/pack.yaml`.

An apparatus is allowed to be noisier than the tolerance — readings scatter, and demanding
otherwise would rule out every physics probe. What it may not do is be noisy *and* take too few
samples, because scatter only averages down with the square root of the count. Get that wrong and
the recorded value moves further than the tolerance on nothing but noise: the row reports `DRIFT`
every single run, forever, and people learn to ignore it.

`bedshock test` checks `spread / sqrt(samples) <= tolerance` for every measured row. The two
halves live in two files that cannot see each other, so nothing but a cross-check catches it.

---

## The box

A measurement taken in a place nobody checked is a measurement of the terrain. An item that stops
after two blocks stopped because it hit a wall; an entity that does not move is standing in a
hole. Both produce a number, both look like physics, and neither is.

```ts
const box = arena(somewhere, { length: 24, height: 4, width: 1, behind: 2 });
box.clear();                          // carve it, floor and all — safe to call every reading
box.sweep('minecraft:item');          // no leftovers from the last reading
const problem = box.verify();         // ...and is it actually there?
```

`verify()` is the point of the file, not a convenience. It catches the chunk that never loaded and
the floor that never went down — the two failures worth telling apart from a result. A probe
reporting *the arena is not clear* has told you something true; one reporting `2.1 blocks` from
the same situation has not.

It is deliberately crude: axis-aligned, `+x` is forward, no rotation, no decoration. A box you can
reason about beats a room you have to model, and every feature added to it is one more thing a
measurement could be blaming instead of the game.

---

## The three ways a search lies

A bisection always converges on something. Point one at a trial that is simply broken and it will
hand back the bottom of the range with the same confidence it hands back a real boundary — and
the number goes into the ledger looking exactly like a measurement. All three of these come back
as `INCONCLUSIVE` with a reason, and **an INCONCLUSIVE answer carries no value at all**, so
nothing downstream can record one by accident.

| What happened | What a naive search does | What this does |
| --- | --- | --- |
| The trial never holds | Converges on `from`, reports it | `INCONCLUSIVE`: *did not hold even at the loose end* |
| The trial always holds | Converges on `to`, reports it | `INCONCLUSIVE`: *held even at the tight end* |
| The boundary is at the edge | Reports the edge | `INCONCLUSIVE`: *converged on the loose end — widen the range* |
| The trial disagrees with itself | Runs forever, or reports half a bracket | `INCONCLUSIVE`: *ran out of trials*, with the bracket |

`INCONCLUSIVE` here means **the apparatus did not answer**. It is not a soft `NO`, and nothing in
the ledger, the report or the status derivation treats it as one.

---

## Without Minecraft

`pack/scripts/bisect.ts` and `pack/scripts/sample.ts` import nothing at all. If your trial is not
a tick loop — an in-memory measurement, a replay, a test — drive them directly:

```ts
import { bisect } from '../vendor/bedshock/pack/scripts/bisect.ts';

const search = bisect({ from: 0, to: 1000, tolerance: 0.01, direction: 'minimum' });
let move = search.begin();
while (!move.done) move = search.record(holds(move.x));
// move.verdict, move.value, move.bracket, move.why
```

```ts
import { summarise } from '../vendor/bedshock/pack/scripts/sample.ts';

const s = summarise(readings, { samples: 5, spread: 0.5 });
// s.verdict, s.value, s.kept, s.observed, s.why
```

Same refusals, same vocabulary, no game required.

---

## Recording, and what comes out

Your pack writes the same wire format ours does:

```
BEDSHOCK RESULT <capability.id> YES {"value":1.35,"measurement":{...},"evidence":"..."}
BEDSHOCK DONE   <count>
```

`bedshock collect <log> --version <v>` reads it. Two rules survive into your pack and neither is
stylistic:

- **A capability id you report must exist in the catalog you collect against**, or the result is
  dropped with a warning. A typo that recorded silently would be a measurement filed under a
  question nobody asked.
- **A log with no `DONE` line is refused wholesale.** If the battery did not finish, the rows
  that never reported are *absent*, not negative, and a prefix of a run stored as a run is how a
  ledger acquires confident negatives about things nobody measured.

Then:

- `bedshock report` — a versioned report. Measured quantities get a log-scale column, so every
  number in the battery lines up on one axis whatever its magnitude.
- `bedshock export --out manifest.json` — the artifact. Keyed by Minecraft version, tagged
  `mc-<version>-<catalog hash>`, with every answer and every value in it.
- `bedshock diff a.json b.json` — what became possible, what stopped working, and **which numbers
  moved under code that still runs**.

A solved row moves into `DRIFT` when two decisive readings on one version differ by more than the
tolerance. Both runs said `YES`; a verdict comparison would call that agreement. That is the
whole reason the row records a number.

---

## Worked example

`pack/scripts/probes/anvilgap.ts` is the one to read, and mostly for the apparatus rather than
the code. It took three shapes, and the two failures are worth more than the working version.

**Make a block appear** beneath a falling anvil at a chosen clearance. Cannot be run at all: the
anvil only exists at tick-spaced positions, so below one tick of travel there is no moment at
which it is 0.3 blocks above anything, and every trial finer than that has to abort — *including
the tight bound*. A search whose tight bound cannot be evaluated has nothing to bisect between.

**Remove a block that was already there**, at the chosen clearance. Runs, and measures nothing.
Bedrock 1.26.36.1 came back with `held even at 0, the tight end of the search` — the anvil got
through even when the block left at the instant of contact. Obvious in hindsight: removal keyed
to the anvil's own arrival is never late. The trial was reporting its own trigger condition and
would have reported the same number on every version of the game. Nothing about reading the code
showed that. It took a run, and the only reason it was caught rather than recorded is that the
search refuses to converge on a bound.

**Remove it and put it back** after a fixed window. Now the clearance sets how *early* the mover
leaves, and the anvil decides whether that was too early. Both ends are grounded in a
measurement rather than in reasoning, and the row can move when the game does.

Three general lessons, in the order they cost the most:

1. **If a search cannot evaluate one of its bounds, change the apparatus rather than the range.**
   Every version of this problem has a phrasing where the unreachable case is a legitimate answer
   instead of a failure, and finding it is most of the work of writing a solve.
2. **A row that cannot move is not a row worth watching.** If a trial's outcome is fixed by its
   own trigger, it will report the same number forever and look like a stable measurement.
3. **A parameter that changes what the number MEANS is part of the question**, not tuning. The
   vacate window here is one, and it is documented as such — readings taken either side of a
   change to it are not comparable, whatever the tolerance says.

That row is also the tunnelling threshold wearing different clothes — what it really measures is
how far the anvil travels while the plane is empty, so anything watching for an intersection
rather than integrating a path inherits it. If it moves, treat every threshold built on "it will
be there when I look" as suspect, including the ones in your own code.
