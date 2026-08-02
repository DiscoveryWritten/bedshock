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
the search, the ledger, the drift detection, and the report.**

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

`pack/scripts/bisect.ts` imports nothing at all. If your trial is not a tick loop — an in-memory
measurement, a replay, a test — drive the search directly:

```ts
import { bisect } from '../vendor/bedshock/pack/scripts/bisect.ts';

const search = bisect({ from: 0, to: 1000, tolerance: 0.01, direction: 'minimum' });
let move = search.begin();
while (!move.done) move = search.record(holds(move.x));
// move.verdict, move.value, move.bracket, move.why
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
