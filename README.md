# bedshock

A capability battery for Minecraft **Bedrock**: what the game can actually do, measured, per
version, written down where a build can read it.

Bedrock's documentation does not cover most of what an add-on actually runs into, and the
surrounding web covers a lot of it wrongly. The usual response is to assume — and an assumed
capability is the most expensive kind of mistake here, because a rendering failure on Bedrock
is *silent*: an unresolvable Molang query does not error, it resolves to `0` and draws
something. The rig renders perfectly and means nothing.

So this repository asks the questions instead, and keeps the answers somewhere a build can
check them.

```bash
npm install
npm run build                            # -> dist/bedshock-*.mcaddon, a probe-only add-on
npx bedshock run --version 1.21.120      # boots a real Bedrock server, records what it says
npx bedshock amend --version 1.21.120    # asks you the rows only eyes can settle
npx bedshock report                      # regenerates docs/ from the ledger
```

## The idea

Three files, and the boundaries between them are the whole design.

| | |
|---|---|
| [`content/capabilities/*.yaml`](content/capabilities/) | **The questions.** Hand-written, and they never contain an answer. A question is the same on every Minecraft version — that is what makes it worth naming |
| [`ledger/observations.jsonl`](ledger/) | **The answers.** Append-only, one line per (capability, version, run). Nothing ever edits one |
| [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) | **Generated.** Do not edit it. Every fact in it is a projection of the ledger |

There is no `status: SETTLED` field anywhere. A status is a *function* of observations, so the
only way to change one is to record a measurement — and the old measurement stays visible
beside the new one. That is the structural version of a rule that used to be prose, and prose
could not stop anybody: **do not edit an expectation to make a probe quiet.**

### Capabilities, not probes

A *capability* is one assertable proposition with one verdict. A *probe* is the apparatus that
reports several of them at once. One container probe settles seven distinct things — whether
storage works, whether a `horse` container opens, whether a `chest` one does, whether the slots
are typed, whether the screen draws what was declared — and those have seven independent
lifetimes. Giving each its own row is what lets six of them go quiet while the seventh stays
open.

### The version axis

A capability is not true or false. It is true or false **on a version**, and the interesting
moment is the one where that changes.

```
                          1.21.120   1.26.30
item.name.glyph_renders_in_colour     yes       yes
render.attachable.reads_held_item_durability      no        ·
```

Which makes narrowing the point of the whole thing. There are three reasons to ask a question,
and they are different questions:

```bash
bedshock run --open     --version <new>   # nobody has answered this here
bedshock run --negative --version <new>   # the answer was NO — the watchlist
bedshock run --regress  --version <new>   # the answer was YES — a drift check
```

**`--negative` is the one that matters most**, and treating it as an afterthought was a real bug
in the first version of this: `--open` excluded measured-`no` rows, so a negative was never
re-asked by any narrowed sweep. That is exactly backwards. A battery for a platform that changes
under you is not mainly there to confirm what already works — **it is there so that the day
something becomes possible, the test that proves it was written months ago.**

So a negative is a question with a pending answer, not a closed file:

```
$ bedshock watchlist

4 capability(s) measured NO on Bedrock 1.21.120.
These are questions with a pending answer, not closed files.

  render.attachable.reads_held_item_durability
    Can a render controller on an attachable read the durability of the item it draws?
    would unblock: The largest single consequence in this battery. If yes, ONE item type
    renders every configuration in the hand and hundreds of baked sprites go away.
```

A sweep on a new Bedrock normally wants `--open --negative`: everything that is not already a
confirmed yes. And `bedshock diff` between two manifests prints `became_possible` first, because
that is the single most valuable line this project can produce.

## Two axes on every row

**What kind of answer it is** — `automated`, `observed`, `derived`, `solved`.

**What would have to change for the answer to change** — and this one is required, because a
consumer asking *"will this still hold if I raise my script pin"* gets a different answer for
each:

| Surface | Moves when | Example |
|---|---|---|
| `engine` | Mojang changes the game | how far a thrown item travels; whether an entity blocks a player |
| `script` | the `@minecraft/server` version moves | whether `setEquipment` sticks; what one knockback unit means |
| `content` | the pack format or the client's handling of it moves | `max_durability` as an int16; whether a flipbook animates an item tile |

A sweep that finds an `engine` row moved has found a gameplay change. A moved `script` row has
usually found an API change. Those are different news, and a row guessed into the wrong bucket
tells someone their pin does not matter when it does.

**This pack always pins the newest script API**, which is the opposite of what a shipping add-on
does and for the opposite reason. A mod pins low because every version it raises is a player
whose game is now too old. bedshock ships to nobody — so a low pin buys no compatibility and
costs the only thing that matters: **a battery cannot ask about an API it did not declare.** An
old pin does not make a newer capability `OPEN`; it makes it *invisible*.

## Measured, observed, derived — and solved

The distinction is not cosmetic, and the runtime cannot blur it.

**`automated`** — the script API decides it with no interpretation. Whether a component reports
the number it was given; whether a dynamic property survives a round trip. These run headless
against a real Bedrock Dedicated Server, so they cost nothing and can sweep versions unattended.

**`observed`** — only a person looking at a screen can answer. Which pixel rows a bar covers;
whether a glyph is coloured; whether four flags render. The battery's job is to set the scene
exactly and enumerate the outcomes, never to guess the result.

**`derived`** — established by reading what the engine or our own emitted files do. Recorded so
nobody re-derives them, and so a future contradiction is visible as one.

**`solved`** — the answer is a **number**, not a yes. *How close can a moving block pass beneath
a falling anvil without interrupting it?* has an answer, and a probe for one of these does not
check a condition — it searches for the boundary.

These are the rows most worth having and the easiest to overlook. A yes/no capability only
reports when something appears or disappears. A solved one reports when **the game's constants
shift underneath a design that was tuned to them** — a reference implementation that still runs,
still passes, and is now subtly wrong. Nothing else in this battery would notice that.

So a solved row drifts on its *value*, not its verdict: two runs both converging is not agreement
if they converged somewhere else. Each declares a `tolerance` taken from its own apparatus's
resolution, because a tolerance of zero reports drift on noise and a drift people learn to ignore
is worse than none.

Values are rendered as one aligned row of text rather than a chart — logarithmic, so a tenfold
change is always the same visible jump and a sixteenth of a block is still a readable length:

```
physics.falling_block.min_clearance_under_a_falling_anvil  ├────●───────────────  0.063 blocks
physics.falling_block.gravity_curve                        ├───────●────────────  0.33 b/tick
physics.knockback.blocks_per_unit                          ├──────────●─────────  1.4 b/unit
physics.throw.item_travel_distance                         ├────────────────●───  28.5 blocks
                                                           ├────────────────────  log scale, 0.01 to 100
```

The bar is for the eye; the number beside it is the record. `bedshock diff` reports a moved value
separately from a status change, because nothing appeared or disappeared — the ground shifted.

A `LOOK` is not a result. The runtime gives it a different verb, and `bedshock run` refuses to
record one. The only path from an eyes-only row to the ledger runs through a person.

## Answering the eyes-only half

Half this battery needs a person. Which pixel rows a bar covers, whether a glyph is coloured,
whether four flags render — no API decides those. There are two ways in, and the first one is
the one that matters.

### The guided session, in game

Import the `.mcworld` from a release, join it, and run one command:

```
/scriptevent bedshock:session
```

It moves you into place for each question, **locks movement so a rig cannot be walked away
from**, points the camera at what is being measured, hands you exactly the items that question
needs, and shows the question with its outcomes as buttons. You look, and you tap.

None of that is a new idea — it is the same `look_at` and `outcomes` every observed capability
has always had to declare, because a probe that cannot say what to look for and how to tell two
results apart is not readable. That requirement turned out to be a UI specification.

At the end you get one line:

```
--- answer code ---
1C3C-2000-G101-G202-G303-G40S-V
9 answer(s). Hand this over; nothing else needs to leave the game.
```

```bash
bedshock redeem 1C3C-2000-G101-G202-G303-G40S-V --version 1.26.36.1
```

**That code is the entire channel out of the game, and it has to be.** `@minecraft/server-net`
says so itself — *"This module can only be used on Bedrock Dedicated Server"* — so a client
add-on has no HTTP, no socket, no egress whatsoever. On a tablet or a console there is no
terminal beside it and nothing to write to. So: one short string per **session**, not one
sentence per question, in Crockford base32 with the confusable glyphs removed, grouped in fours
to be read off a screenshot.

It is checksummed, and that part is not decoration. A code that will not decode costs one
re-read. A code that decoded to *different valid answers* would put measurements nobody made
into an append-only ledger that other repositories build on, and nothing downstream could ever
tell. A single mistyped character, or two swapped, is refused:

```
! checksum SV does not match QE. Something was mistyped or misread — re-read the code
  rather than adjusting it.
```

The code also carries the catalog revision, because outcome indices are **positional** — a
question edited since the session moves every index after it, so a code from another revision is
refused rather than filed against the wrong questions. And the verdict recorded is the one the
catalog declares for that outcome, never one carried in the code: the code says which button,
the catalog says what it meant.

### Or from a terminal

`bedshock amend` asks the same questions with the same answer space, for when you do have a
keyboard next to the game.

```
[3/9] item.icon.animates_from_flipbook  (P10)

  Does an item atlas tile animate from a flipbook_textures entry?

  Look at:
    The two flipbook probe items in your hotbar. They carry the SAME animation under two
    deliberately different spellings — one with explicit frames and blend off, one omitting
    frames with blend on. Different in every field that could plausibly be the mistake.

  1) Both icons cycle  [YES]
  2) One cycles, one is frozen  [YES]
       Item flipbooks work and the frozen spelling was simply wrong. Note which one cycled.
  3) Both frozen on frame 0  [NO]
       Still short of proof. The definitive control is a flipbook on a BLOCK texture.
  4) Cannot tell — the frames may be too similar, or nothing rendered  [INCONCLUSIVE]
  s) skip   q) stop here
```

Either way, **every observed row must offer an "I could not read it" answer** — `bedshock
validate` refuses one that cannot. A rig that did not render is not a negative result, and a
person forced to pick a real verdict for a broken apparatus will pick one.

## Using it from another pack

bedshock is a **dev-time** dependency. Nothing from it ships in your add-on.

Cite a capability where your code rests on it:

```ts
/** @requires bedshock:item.max_durability.int16_ceiling */
const PACKED_MAX = 32767;
```

and check the citations against your pack's own floor:

```bash
npx bedshock check --requires-from 'packs/**/*.ts' --version 1.21.120
```

```
FAIL packs/behavior/scripts/gun.ts:212
     @requires bedshock:item.creative.order_follows_emission
     never measured at or below 1.21.120. This is a guess, however confident the code around
     it looks. Run the battery, or carry a fallback and stop citing it.
```

**Evidence inherits downward and never upward.** A capability measured on 1.26.30 says nothing
about a pack declaring it runs on 1.21.120 — the newer engine is exactly where a thing that did
not used to work starts working. A pack that wants a capability its floor cannot prove has to
raise the floor or carry a fallback.

### Citing a negative

Half the decisions downstream of a capability battery are made from *absences*. Hundreds of
sprites get baked because a render controller cannot read the item it draws; a codec refuses
shulker boxes because nothing can carry one opaquely. Those rest on a capability too — on it
being measured **no** — so they get their own form:

```ts
/** @requires-not bedshock:render.attachable.reads_held_item_durability */
const BAKED_SPRITES = everyCombination();
```

That passes while the row is `CLOSED-NEGATIVE`, fails while it is unmeasured — an absence
nobody confirmed is as much a guess as a presence nobody confirmed — and **warns the day the
row turns positive**, naming the workaround that has become unnecessary.

Which is the version axis paying off. A question stays in the catalog after its answer is no;
`--open` re-asks it on each new Bedrock; and when one finally comes back yes, the build tells
you what you can now delete. Nobody has to remember to go and re-read a document.

There is a programmatic form too, for a build that prefers a list to comments:

```ts
import { requireCapabilities } from 'bedshock';
requireCapabilities({ version: '1.21.120', ids: [...] });   // throws, naming every failure
```

## The manifest, and releases

The Markdown is for people. `bedshock export` writes the thing a machine reads:

```json
{
  "schema": 1,
  "minecraft": "1.21.120",
  "catalog_revision": "rc3c24c08",
  "release": "mc-1.21.120-rc3c24c08",
  "counts": { "SETTLED": 22, "CLOSED-NEGATIVE": 4, "OPEN": 18, "INCONCLUSIVE": 1, "derived": 15 },
  "watchlist": ["render.attachable.reads_held_item_durability", "..."],
  "capabilities": [ { "id": "...", "status": "...", "inherited": false, "outcomes": [...] } ]
}
```

**A manifest has two halves to its identity**, and both are in the tag. The Minecraft version is
one; the other is the catalog of questions that were asked, because adding a question or widening
an answer space makes the *same* game yield a *different* manifest.

| Tag | |
|---|---|
| `mc-1.21.120-rc3c24c08` | Immutable. This catalog, measured against this game, forever |
| `mc-1.21.120` | **Moves.** Always the newest revision for that game |

Pin the moving tag for the best answers available on the game you run, or the full id for a
byte-identical artifact. The revision is a content hash rather than a counter, because a counter
is a thing somebody has to remember to bump.

## Vendoring it

bedshock is meant to be submoduled. `action.yml` is a composite action, so a repository that
vendors it at `vendor/bedshock` runs it as a local action with no registry and no credential:

```yaml
- uses: ./vendor/bedshock
  with:
    mode: run
    server-url: https://.../bedrock-server-1.26.36.1.zip   # any version, any server build
    record: true
```

**And it can measure into its own ledger.** `catalog` and `ledger` inputs — or the
`BEDSHOCK_CATALOG` / `BEDSHOCK_LEDGER` environment variables locally — point the apparatus at
files in *your* repository:

```yaml
- uses: ./vendor/bedshock
  with:
    catalog: capabilities/          # your questions
    ledger: capabilities/observations.jsonl
    manifest-out: dist/my-capabilities.json
```

That is deliberately a first-class path rather than a hack. A project that measures its own
answers has a better proof than one citing ours, and the code that enforces the discipline —
append-only answers, an enumerated answer space, an absent run never recorded as a negative — is
the part worth sharing. The questions in this repository are one instance of it.

### Solving for your own numbers

Vendoring gets you the apparatus, and the apparatus includes the search. `bedshock init` writes a
catalog, a probe and an empty ledger that already validate:

```
bedshock init capabilities --domain portals --bedshock ../vendor/bedshock
```

The probe it writes imports from [`pack/scripts/harness.ts`](pack/scripts/harness.ts), which is
the contract for somebody else's pack — `solve`, `bisect`, and the wire format. Write a trial,
declare a range and a tolerance, and your numbers come out in the same shape ours do: same
collector, same drift detection, same log-scale column, your own manifest with its own release
tag.

This matters because a capability battery has two halves and only one of them generalises. Nobody
else can ask how much upward boost your horizontal portal needs to clear the floor on exit, or
the speed above which something crossing your trigger volume is never seen inside it. Those are
questions about your code — but they are the same *kind* of question, and a boundary that moves
between Minecraft versions is worth knowing about whoever owns it.

[`docs/SOLVING.md`](docs/SOLVING.md) is the walk through, including the three ways a search
converges on a number that is not a measurement, and what this does about each.

The server is a seam too: `server-url` takes any Bedrock Dedicated Server zip, and `log` skips
the server entirely so a harness this action does not know how to start can feed a battery log in
and get the same collection rules applied to it.

## Where things are

| | |
|---|---|
| [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) | The matrix: every capability × every version. **Generated** |
| [`docs/versions/`](docs/versions/) | One report per Minecraft version. **Generated** |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Why it is shaped this way, and which failures each rule is for |
| [`docs/PORTING.md`](docs/PORTING.md) | Moving a messy in-repo test battery onto this |
| [`docs/SOLVING.md`](docs/SOLVING.md) | Measuring a number instead of a yes — and doing it with your own questions |
| [`content/capabilities/`](content/capabilities/) | The questions |
| [`content/pack.yaml`](content/pack.yaml) | The probe pack's identity and every apparatus parameter |
| [`ledger/`](ledger/) | The answers |
| [`pack/scripts/`](pack/scripts/) | The in-game runtime |
| [`pack/scripts/harness.ts`](pack/scripts/harness.ts) | The entry point for somebody else's pack |
| [`tools/`](tools/) | Everything else, and its tests |

## Commands

| | |
|---|---|
| `bedshock validate` | The questions and the ledger, checked against each other |
| `bedshock build` | Emit the probe pack |
| `bedshock run [--open] [--negative] [--regress]` | Boot a real server, record the automated answers |
| `bedshock collect <log> --version v` | Record from a log captured elsewhere |
| `bedshock amend [--probe p] [--all] [--negative]` | Answer the eyes-only rows from a terminal |
| `bedshock redeem <code> --version v` | Record a guided session's answer code |
| `bedshock report` | Regenerate `docs/` |
| `bedshock check --requires-from <glob> --version v` | Fail a build resting on an unsettled capability |
| `bedshock watchlist [--version v]` | Every row measured NO, and what flipping it unblocks |
| `bedshock export [--version v] [--out f]` | The machine-readable manifest |
| `bedshock diff <a.json> <b.json>` | What moved between two manifests |
| `bedshock status [prefix]` | What the ledger says right now |
| `bedshock init [dir] [--domain d]` | A catalog, probe and ledger of your *own* questions |
| `bedshock tidy` | Sort the ledger file. Never alters a line |

---

**The pack ships no gameplay.** It is nothing but instruments, several of them deliberately in
the creative menu because whether they can be kept *out* of it is one of the questions. Install
it, ask, record, remove.
