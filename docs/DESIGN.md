# Why it is shaped this way

Every rule below exists because of a specific way a capability battery goes wrong. Most of them
were learned in a live add-on repository, written down as prose, and then broken anyway —
because prose cannot stop anybody. What is here is the version that survives someone being in
a hurry.

---

## 1. The question and the answer live in different files

`content/capabilities/*.yaml` contains questions and never answers. `ledger/observations.jsonl`
contains answers and never questions.

**The failure this is for.** A battery that stores its expectations next to its results has one
edit that makes it worthless: adjusting an expectation until a probe stops complaining. It
looks like maintenance. It reads as a tidy diff. And afterwards the document asserts something
nobody measured, with every downstream design resting on it.

Keeping them apart does not make that edit hard — it makes it *impossible*, because there is no
expectation to edit. A capability has no field that could hold a verdict, and `catalog.test.ts`
fails if one appears. To change what the matrix says you have to record a measurement.

**The corollary that makes it work:** `docs/CAPABILITIES.md` is generated. A hand-maintained
capability document is a set of copies, and a copy can rot. The generated one cannot disagree
with the ledger because it *is* the ledger.

## 2. A status is derived, never stored

`SETTLED`, `CLOSED-NEGATIVE`, `OPEN`, `INCONCLUSIVE`, `DRIFT`, `UNDERMINED` are computed in
`ledger.ts` from the observations at a version. `ledger.test.ts` is the specification of what
each word means, which is the only place they are defined.

Two of them are worth spelling out.

**`INCONCLUSIVE` is not a soft `NO`.** It is the verdict for a run where the apparatus could not
be trusted — a control that did not draw, a rig too small to read, a probe that measured the
instrument rather than the game. Collapsing it into `NO` is how a battery starts producing
confident answers to questions it never asked. It also does not retract an earlier good
measurement: a later broken run means the instrument needs fixing, not that the game changed.

**`UNDERMINED` is the bisect floor, made mechanical.** A row settled downstream of an open one
may have rendered perfectly and still been reading the instrument. `depends_on` records the
chain and the rollup refuses to present the top of it as settled while the bottom is open. This
is the lesson from a rig that could not say whether attachables worked on custom items *at
all*, and which cost a session before a floor was put underneath it.

## 3. Capabilities are atomic; probes are not

One probe reports many capabilities. The container probe alone settles seven propositions with
seven independent lifetimes.

The alternative — one row per probe — is what the document this grew out of did, and its cost
is visible in that file: rows carrying five sub-questions and a status of `PARTIAL`, where
`PARTIAL` means "some of this is true and you will have to read the prose to find out which."
`PARTIAL` is not a state a build can check. Seven rows, six settled and one open, is.

It also fixes what "the known stuff goes away" means in practice. A settled capability stops
being re-derived; its probe demotes from a question to a drift check; and the code that rests on
it cites the id rather than restating the finding. **A restatement is a copy that can rot. A
citation cannot.**

## 4. The version axis, and its asymmetry

Every observation is keyed to the Minecraft version it was true on. Evidence inherits
**downward** to a later version and **never upward** to an earlier one.

Downward, because patch versions rarely remove things and demanding a fresh run for every
Bedrock release would make the check something people switch off. If one does remove something,
`--regress` says so.

Upward, never, because the newer engine is *exactly* where a thing that did not used to work
starts working. A measurement on 1.26.30 offered as evidence about a pack declaring 1.21.120
would ship a pack that loads for nobody. `bedshock check` can therefore only ever be satisfied
by a measurement at or below the pack's own floor.

This is also what makes the battery worth keeping for months rather than running once. A
question stays in the catalog after its answer is `NO`, and `--open` re-asks it on each new
version. The test for a capability that does not exist yet is written before it exists.

## 5. `LOOK` is not a result, and cannot be made into one

The runtime has separate verbs. `run.ts` records `RESULT` lines and refuses `LOOK` lines — and
refuses a `RESULT` for a capability the catalog marks `observed`, so even changing the runtime
would not get a guess into the ledger.

The only path from an eyes-only row to a record runs through `bedshock amend`, where a person
picks from an enumerated answer space, and `validateLedger` checks that the recorded verdict
matches what that outcome means.

## 6. The answer space is data, not prose

Every `observed` capability declares `outcomes`. `catalog.ts` enforces three things about them:

- there must be an outcome meaning **YES** and one meaning **NO**, or the probe cannot come back
  two ways and is not measuring anything;
- there must be an outcome with verdict `INCONCLUSIVE`, because a rig that did not render is not
  a negative result and a person forced to pick a real verdict will pick one;
- every outcome needs a stable id, because that id is what lands in the ledger.

**Writing the outcomes down before running is what surfaces a collision in them.** The
cautionary tale is a rig whose two candidate readings — "the query is live" and "the query is
blind" — produced a pixel-identical picture, for structural reasons that were baked in from the
first version. Two sessions went into that before the reading was made differential. An answer
space you have to enumerate is an answer space you notice is degenerate.

## 7. An absent answer is never a negative one

Three refusals, all the same principle:

- `bds.sh` exits non-zero if the battery never printed `DONE`, and records nothing.
- `collect.ts` rejects a log with no `DONE` line **wholesale** — not the results it found, all
  of them. A prefix of a run is not a run.
- `run.ts` refuses to guess a version. A result in the wrong column is worse than no result.

The likeliest cause of a silent battery is Bedrock rejecting the entire behavior pack over a
script module version it does not have. That says everything about the manifest and nothing
about the game, and recording it as a screenful of negatives would poison the ledger with
confident findings about capabilities nobody measured.

This is also why the battery boots a real **server** rather than trusting a client. A client
rejects a bad pack silently — no error, the content is simply not there. The server prints the
reason.

## 8. Every observed probe carries a control

Wired to a literal, wherever there is one to have. When every link checks out and the rig still
fails, the thing that saves the session is knowing whether the instrument works.

The specific hazard behind this is `render.molang.unknown_query_resolves_to_zero`: an
unrecognised Molang query does not error and does not stop the controller. It resolves to `0`
and draws index 0. So a flag can render perfectly and mean "blind", which makes index 0 the
signal for a dead query — and no expectation may land there except one that expects zero anyway.
That row exists to be cited by other probes' *designs*.

## 9. Nothing is offset by zero

An attachable's anchor is on the body, so probe geometry placed at the anchor renders perfectly
and is occluded by the player. This has cost two separate readings. Offset first, then measure —
and offset on two axes, because *which way is forward* is often part of what is being measured
and a one-axis guess can bury the rig again.

## 10. A probe that has two halves stamps a session token

Any measurement whose subject is *the passage of time* — surviving a world reload, surviving a
chunk unload — has a defect available to it: reporting the same PASS whether or not the thing
in between actually happened. A run made in one sitting is then indistinguishable from the run
that answers the question.

The fix is structural rather than a note in the instructions. The stamp carries a value computed
at **module scope**; script modules are re-evaluated on every world load, so it is new each
session by construction and nothing has to remember to change it. The follow-up compares and
says outright whether a reload happened. And a same-session fetch does not spend the stash —
handing the item back would consume the one setup that can answer the real question.

## 11. Single-variable comparisons, enforced

The `chest` and `horse` container entities are generated from one template with only
`container_type` substituted. `pack.test.ts` asserts they are otherwise byte-identical, and
`config.ts` refuses a configuration where the two families share no size.

That is what turns "the horse one opened and the chest one did not" into an attributable
finding instead of a guess about which of a dozen ingredients mattered.

Two spellings of the flipbook entry, differing in every field that could plausibly be the
mistake, are the same idea: one frozen icon cannot distinguish "item atlas tiles do not
flipbook" from "this entry is wrong."

## 12. Ids are a public interface

Other repositories cite them in source and their builds fail on a citation that does not
resolve. Renaming one is a breaking change. `check.ts` reports an unresolvable citation as an
error rather than a warning precisely so that a rename is loud where it lands.

---

## What is deliberately not here

**A pass/fail gate on the battery itself.** A probe reporting `NO` is a finding about Bedrock,
not a broken build. Only `DRIFT` and a battery that failed to report are failures.

**Any way to run this in a shipped pack.** bedshock is a dev-time dependency. Its own pack is a
separate artifact with its own UUIDs, installed to ask questions and removed afterwards. A host
pack consumes the *ledger*, never the probes.

**An `expect` field.** It has been proposed twice while writing this and it is the same idea as
§1 wearing a hat. The recorded observation is the expectation; drift is the ledger disagreeing
with itself.
