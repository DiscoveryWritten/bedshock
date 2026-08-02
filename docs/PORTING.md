# Moving a battery out of the pack it grew inside

Written against a real migration: `composable-portals`, whose `docs/CAPABILITIES.md`,
`content/probes.yaml`, `tools/gen_probes.ts` and `packs/behavior/scripts/spike_caps.ts` are
where most of this repository came from.

## The line

**A test that measures Bedrock moves here. A test that measures your mod stays.**

That line is sharper than it sounds, and it settles almost every case on its own:

| Stays in the host pack | Moves to bedshock |
|---|---|
| Does *my* portal land on the right block? | Does a custom entity's container open for a player? |
| Does *my* gun's UI show the right chamber? | Does a form button's `iconPath` resolve an unindexed texture? |
| Does *my* recipe unlock? | Can items be kept out of the creative menu? |
| Does *my* placement maths handle a ceiling? | Can a render controller read the held item's damage? |

The tell is whether the answer would still be interesting to someone building a completely
different add-on. If yes, it is a statement about Minecraft and belongs in a version-keyed
ledger. If no, it is a statement about your code and belongs in your test suite.

**The messy middle is calibration.** A spike that measures the units of `applyKnockback`, or the
gravity curve of a vanilla falling block, is measuring Bedrock even though it exists to serve
one feature. Those move. What stays behind is the feature's own use of the number.

## The order to do it in

### 1. Split each existing probe into propositions

This is the real work, and it is worth doing before touching any code. Take a probe and write
down every distinct thing it settles. One container probe was seven. One durability probe was
three.

For each, ask the question `content/capabilities/` requires: **which decision does this block?**
If that is hard to answer, the row probably should not exist yet. A probe with no decision
behind it is one nobody will read the result of.

### 2. Seed the ledger with what you already measured

Answers you have already paid for are the most valuable thing you own. Write them as
observations with `platform: "imported"`.

**Be honest about the version.** This is the one place a migration is genuinely lossy: a
document that recorded "measured on *(client version)*" cannot tell you which Bedrock it was.
Attribute to the pack's declared floor, say so in the `note`, and let the first real run replace
it. Do not backfill a version you are inferring — the whole point of the axis is that a wrong
column is worse than an empty one.

Be honest about *strength*, too. Where a finding was weaker than the question it was recorded
against, say which outcome it actually supports. In this migration, a stash probe that verified
a gun carrying dynamic properties — not the filled shulker box the design was really about —
got an outcome of its own (`returned_but_contents_unverified`) rather than being rounded up to
a clean YES. Adding an outcome that describes the evidence you have is cheaper than a row that
overstates.

### 3. Delete the host's copy — but only what is genuinely duplicated

Once a capability is settled in the ledger, the host-side test that was really re-checking it
goes. In this migration that eventually retires `spike_caps.ts` (1,286 lines), `gen_probes.ts`
(716), `probes.yaml` (242) and `probes.test.ts`, plus the battery half of `smoke-test.sh`.

**Two things stay behind, and neither is an oversight.**

The first is any rig this repository has not rebuilt yet. Deleting the host's copy first would
leave the apparatus in neither place; the build's cross-check prints that list on every run, so
it shrinks rather than being remembered.

The second is subtler and more valuable. **A host repository accumulating code that its own
findings say will fail is a source of future negative probes, not dead weight.** When a mod moves
a design into a branch because a capability came back no, that branch is the most concrete
statement anyone has of what the capability would have been *for* — and it is exactly the
material a future `--negative` probe wants when the question is re-asked on a newer Bedrock.

So: take from it when it is useful, and do not tidy it away. A negative in this ledger is a
question with a pending answer, and the host's abandoned branch is the answer's other half.

Replace each with a citation where the code rests on the finding:

```ts
/** @requires bedshock:item.max_durability.int16_ceiling */
const PACKED_MAX = 32767;
```

and wire the check into the build:

```json
"scripts": {
  "capabilities": "bedshock check --requires-from 'packs/**/*.ts,tools/**/*.ts' --version 1.21.120"
}
```

The version is your pack's own `min_engine_version`. Nothing else is correct: a capability
measured above your floor is not evidence about your floor.

### 4. Keep the host's own suite

Everything that measures your mod stays exactly where it is. Nothing about this migration makes
an integration suite less necessary — it makes it *smaller*, because the rows it was carrying on
Bedrock's behalf now live somewhere they can be version-keyed and re-checked without a release.

## What gets better, concretely

**Player-heavy tests stop being re-run.** The reason a battery is exhausting to run is that
every session re-asks everything, including the parts settled six months ago. `bedshock amend`
offers only the rows this version has no answer for, dependency-free ones first, so a session
naturally works bottom-up through a bisect chain instead of starting at the top and finding it
unreadable.

**"Has this become possible yet?" becomes a command.** `bedshock run --open --version <new>`
against each new Bedrock. The questions are already written; the negatives from a year ago are
already there to be contradicted.

**A capability answer stops being tied to a release.** In the host repo, re-measuring meant
building the pack, bumping a version, uploading, and installing. Here the artifact is one
probe-only add-on with its own UUIDs, and the automated half needs no client at all.

**Citations get checked.** The rule "an `OPEN` row is a guess, do not build on one" was obeyed
by reading. Twice a design came to rest on an unmeasured capability anyway, because a citation
and a guess look identical in a diff.

## What to watch for

**Do not delete a host's failing code because a row went negative.** A capability answered `no`
is not an instruction to erase the design that wanted it. The design is the clearest available
description of what a flip would unblock, and it is what the probe should be re-derived from
when the question is asked again. Read it, take from it, leave it where it is.

**Do not move a probe and its answer in one commit.** Move the question first, seed the answer
from the document, verify the report says what the document said. Only then delete the host's
copy. A migration that loses a measurement is worse than one that takes two commits.

**Do not let the host pack depend on the probe pack at runtime.** Different UUIDs, different
artifact, never in a release build. If a host build ever needs bedshock at runtime, something
has been imported that should have been cited.

**An id is forever.** Once a host repository cites `item.max_durability.int16_ceiling`, renaming
it breaks that build. Spend the time on the name before the first citation, not after.

## Still to port from this migration

Named rather than quietly omitted, because the build warns about exactly this list and a
shrinking list is the progress bar:

- **`attachable`** — the four-flag differential rig for `render.attachable.*`. The largest asset
  chunk, and the least urgent: its two load-bearing rows are already settled (one YES, one
  CLOSED-NEGATIVE), so the probe is currently only wanted for drift and for re-opening the
  durability-query question on a newer engine.
- **`attachable_pose`** — the separate rig for vanilla hold animations. Must not be folded into
  the flag rig; posing those flags into the hand would make them small and half-occluded, which
  is the exact failure that rig has been repaired for twice.
- **`stash`** — the two-phase holder round trip. Its session-token discipline is already
  implemented in `probes/dynprops.ts` and should be lifted rather than rewritten.

One row is deliberately **not** seeded: `render.attachable.several_controllers_at_once`. The
host document leaves it unmeasured, and while its four-flag rig plainly did draw four flags at
once, that is an inference from a probe pointed at a different question. Recording an inference
as a measurement is the thing this repository exists to stop, so it stays `OPEN` until the
probe is ported and run.
