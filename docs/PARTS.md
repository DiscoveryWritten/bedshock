# Parts, stacks and the board

**This is a proposal, not a built thing.** It takes [`TECHNIQUES.md`](TECHNIQUES.md) from an
argument to a shape, answers two of its open questions (the name, and where a reference
implementation lives), and adds the one rule below that is not up for argument.

## The rule first: outside testers release a result and do nothing else

Set 2026-11-24, by the owner of this repository. It overrides anything in this file, and any
proposal about this file, that disagrees. It is written down so that no agent spends a turn
nudging toward a flow it rules out.

- **Every upload carries a needs list**: the tests it wants that only a person or a piece of
  hardware can give. A device, a platform, a version nobody here runs, an eyes-only row.
- **Anyone can take the bedshock-rigged build** of that upload and play it. The rigged build is
  the same pack with the battery's instruments mounted, so it reports what happened on the device
  it ran on.
- **The result folds back in. That is the whole point.** A test that runs and does not come back
  did not happen.
- **The tester's only act is releasing the result.** No account, no key, no token, no password,
  no code to read off a screen and type, no form, no sign-in, no "step two". A return path that
  needs any of those is not a candidate, and is not worth an equivocating paragraph. If the log
  has to be taken by extreme means so the person does not have to do anything, it is taken by
  extreme means.
- **The minimum that must exist before anything else:** a **completion manifest** that the rigged
  build writes (which build, which catalog revision, which needs it ran, what each said), that is
  **verified on return** against the build and catalog it claims, and **public stats** posted
  from the verified ones.

The transport is deliberately unsolved here. That is not doubt that one exists: designing it is
expected to be easy once it is the thing being worked on. Until then, the open space stays open
rather than being filled with a compromised flow.

What this rule judges in the repository as it stands:

- [`HARNESS.md`](HARNESS.md)'s *thin mode* already says it for the station's own device: *no
  answer codes, no transcription.* This extends that to strangers.
- The answer code (`bedshock redeem`) and the report page `harvest` reads from both ask a person
  to carry something. They stay useful to whoever chooses them. They are not the board's return
  path.
- What carries over from `harvest` unchanged: **verification never depends on who the tester
  is**, disagreement between two devices on one version is reported rather than averaged away,
  and an outside result reaches the ledger by pull request, never by push. Those are checks on
  our side. None of them asks the tester for anything.

## The words

| | is | lives |
|---|---|---|
| **capability** | one fact about the game, on a version | `content/capabilities/`, answered in `ledger/` (as now) |
| **part** | the smallest importable thing that does one composed job, plus a test that says whether it still stands | lodged on Waterfall under a git tag |
| **library** | a named set of parts released together (the belt's core, this repo's harness) | a tag on the set |
| **stack** | libraries and parts installed together, at versions | declared by whoever wants it tried |
| **board** | every stack × Minecraft version, with a state and the evidence for it | here, public, generated |

A part is what `TECHNIQUES.md` called a technique, once it is something you can import and not
only read. "Part" because it is built to be used inside something else.

**Waterfall keeps the files. bedshock vouches for them.** Waterfall is already a shelf that
agents can publish to with their own token, whose tags cannot move, and whose `sources.txt` any
script can read without signing in. That is the whole of what lodging needs. The board reads
`sources.txt`, never the other way round.

## Two feature lists

Every part carries both, and they are kept apart on purpose.

- **`features`**: what a person would call it. *Paged storage. Fall detector. Portal gun.*
  Written by whoever built it, and allowed to be persuasive.
- **`spec`**: the system specs. **Computed from the built bundle, never typed**, the same
  relationship `docs/CAPABILITIES.md` has to the ledger:
  - capabilities cited (`@requires`, `@requires-not`), followed into the parts it imports
  - script modules and their versions, `min_engine_version`, experiments needed
  - every name it claims: identifiers, dynamic property keys, entity tags, scoreboard objectives,
    `scriptevent` ids, structure names
  - what it spawns, keeps loaded or runs every tick
  - every API member it calls, checked against the module version it declares

Because the spec is derived, nobody can oversell one, and searching it is searching facts.

The last line of that list is the origin story. Zero Fall Challenge 1.0.0 arrived on Waterfall
resting entirely on `player.resetFallDistance()`, which is not in the Script API: a confident
invention that made the pack inert. A spec check at lodging time refuses that upload before
anyone installs it.

## The board

The board records **attestations** the way the ledger records observations: append-only, one
line per (stack, version, run), nothing ever edited.

States are per stack per version, taken from `TECHNIQUES.md`:

| | |
|---|---|
| `STANDING` | stood up on this version, and nothing it cites has moved since |
| `SUSPECT` | something it cites moved in the ledger. Computed, nothing re-run. **Not a failure** |
| `BROKEN` | re-run on this version, and it did not stand |

A stack adds checks no single part can fail:

- **collisions**: two parts claiming the same name, read straight off their specs
- **doubles**: the same layer loaded twice (the belt's `pcore:hello` census already sees this)
- **every part's own test, run inside the stack**, because a part that stands alone and falls in
  company is the finding a stack exists to make

Searching it, as queries over data that exists anyway:

- parts that need no experiments on 1.21.120
- everything resting on `item.dynamic_properties.*`
- stacks containing a given part that are `STANDING` on the newest version
- **when a capability turns yes**: every part whose `@requires-not` workaround can now go
- **when one regresses**: every stack that just went `SUSPECT`

The needs list belongs on the board too: wanted human and hardware tests, each with its rigged
build, and beside it the stats from returned completion manifests (taken, returned, verified,
refused and why, by device, platform and version).

## Lodging a part: the brief for an agent

> Build one part. It does one composed thing and nothing else. Someone who has never seen the
> pack it came from must be able to read it.
>
> 1. Cite every capability it rests on with `@requires bedshock:<id>` or
>    `@requires-not bedshock:<id>` at the line that rests on it. If the capability has no row,
>    add the question to `docs/WANTED.md` instead of assuming the answer.
> 2. Write its test: the smallest run that says whether it still stands on a version.
> 3. Write `features` in plain words. Do not write a spec; it is computed.
> 4. Write its `needs`: what only a person or a device can tell us about it. Empty is allowed.
> 5. Keep its failures: the shapes that did not work, and why. They are what a reader would try
>    first.
> 6. Tag it, annotated, and lodge it with `waterfall.mjs publish` using your own agent token.
>    Tags never move. A fix is a new tag.

First candidates, already written and already tested:

- **paged world store**: `pack/scripts/codec.ts`, `symbols.ts`, `pages.ts`, `reload.ts`.
  `TECHNIQUES.md` names it as the first technique.
- **elevation classifier**: from Zero Fall Challenge. Did this change in height come from water,
  a boat, a pearl, or a fall?
- **hello and census**: from the belt's core in `portal-arena`. Which layers are present, and is
  any of them here twice?

## What has to be built, in order

1. **`bedshock check` follows imports.** Today it reads `@requires` from the consumer's own files
   and does not follow them into code it imports. That is tolerable while everything is ours and
   becomes the main weakness once other people's packs import parts.
2. **The spec extractor**, run against a bundle. The API-member check against the declared
   module version comes first, because it is the one that would have caught Zero Fall.
3. **A `part` kind on Waterfall**, and `kind=part` on its `sources.txt` lines.
4. **The attestation ledger and the generated board.**
5. **The rigged build and its completion manifest**, under the rule at the top.

## Open

- **One repository of parts, or one per part.** Waterfall binds an item to the first repository
  that publishes into it, and `waterfall.mjs` checks that a tag's version matches the manifest's.
  One repository with per-part tags (`elevation@1.0.0`) is easier for agents and needs
  `waterfall.mjs` to accept that tag shape.
- **Who re-runs `SUSPECT`.** Still `TECHNIQUES.md`'s question. Outside testers answer part of it
  for the rows that need a device.
- **What the rigged build is called** on the shelf, so a player knows what they are installing.
