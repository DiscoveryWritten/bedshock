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

## Measured, observed, derived

The distinction is not cosmetic, and the runtime cannot blur it.

**`automated`** — the script API decides it with no interpretation. Whether a component reports
the number it was given; whether a dynamic property survives a round trip. These run headless
against a real Bedrock Dedicated Server, so they cost nothing and can sweep versions unattended.

**`observed`** — only a person looking at a screen can answer. Which pixel rows a bar covers;
whether a glyph is coloured; whether four flags render. The battery's job is to set the scene
exactly and enumerate the outcomes, never to guess the result.

**`derived`** — established by reading what the engine or our own emitted files do. Recorded so
nobody re-derives them, and so a future contradiction is visible as one.

A `LOOK` is not a result. The runtime gives it a different verb, and `bedshock run` refuses to
record one. The only path from an eyes-only row to the ledger runs through a person.

## Answering the eyes-only half

`bedshock amend` replays the last run's `LOOK` rows on a machine with a keyboard, while you
play on whatever device you are on. Nothing has to escape the client.

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

What makes that more than a notes file is that **the answer space is declared in the
capability**. Every observed row must say what to look at, must be able to come back both YES
and NO, and must offer an *I could not read it* answer — `bedshock validate` refuses one that
cannot. A rig that did not render is not a negative result, and a person forced to pick a real
verdict for a broken apparatus will pick one.

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
| [`content/capabilities/`](content/capabilities/) | The questions |
| [`content/pack.yaml`](content/pack.yaml) | The probe pack's identity and every apparatus parameter |
| [`ledger/`](ledger/) | The answers |
| [`pack/scripts/`](pack/scripts/) | The in-game runtime |
| [`tools/`](tools/) | Everything else, and its tests |

## Commands

| | |
|---|---|
| `bedshock validate` | The questions and the ledger, checked against each other |
| `bedshock build` | Emit the probe pack |
| `bedshock run [--open] [--negative] [--regress]` | Boot a real server, record the automated answers |
| `bedshock collect <log> --version v` | Record from a log captured elsewhere |
| `bedshock amend [--probe p] [--all]` | Answer the eyes-only rows |
| `bedshock report` | Regenerate `docs/` |
| `bedshock check --requires-from <glob> --version v` | Fail a build resting on an unsettled capability |
| `bedshock watchlist [--version v]` | Every row measured NO, and what flipping it unblocks |
| `bedshock export [--version v] [--out f]` | The machine-readable manifest |
| `bedshock diff <a.json> <b.json>` | What moved between two manifests |
| `bedshock status [prefix]` | What the ledger says right now |
| `bedshock tidy` | Sort the ledger file. Never alters a line |

---

**The pack ships no gameplay.** It is nothing but instruments, several of them deliberately in
the creative menu because whether they can be kept *out* of it is one of the questions. Install
it, ask, record, remove.
