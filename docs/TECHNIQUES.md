# Techniques — reference implementations with a version behind them

**This is a proposal, not a built thing.** Nothing in `tools/` implements it yet. It is
written down so the shape can be argued with before anybody builds it.

## The gap

A capability answers *can Bedrock do X*. It is a primitive, it is measured by one probe, and
its answer is a fact about the game.

That is not what most hard-won knowledge looks like. The expensive things are **composed** —
several capabilities stacked into an arrangement that works, usually after several that
didn't. An entity property driving a render controller's texture array. A marker bisect that
finds which of four silent failures is the real one. A registry that survives chunk unload
because the entity never could. None of those are a capability. Each rests on several, plus a
shape that somebody worked out.

Today that knowledge lives in `DESIGN.md` and `SOLVING.md` as prose, which is the right place
for the reasoning and the wrong place for the claim. Prose cannot tell you it stopped being
true. A technique described in a document is exactly as credible as an unreported version
number: it worked, once, for whoever wrote it down.

## What a technique is

A named arrangement with four things attached:

1. **The capability ids it rests on.** Not prose about them — the actual ids, cited.
2. **A reference implementation.** Minimal, runnable, and *only* the technique. If it needs
   the rest of an add-on to make sense, it is not a reference implementation.
3. **A test that says whether it still stands**, runnable against a version.
4. **The versions it has actually been stood up on.** Recorded like an observation, because
   that is what it is.

## The mechanism that makes it cheap

Citing the capability ids is not bookkeeping. It is the detector.

**When a cited capability's answer moves in the ledger, every technique resting on it becomes
`SUSPECT` — computed, with nothing re-run.** The ledger is already append-only and already
per-version, so this falls out of data the repo keeps anyway. Running the reference
implementation is the *confirmation*, and confirmation is the expensive half: it needs a real
server, which is the one thing here that is slow and stateful.

So three states, per technique per version:

| | |
|---|---|
| `STANDING` | Stood up on this version, and nothing it cites has moved since |
| `SUSPECT` | Something it cites moved. Nobody has re-run it. **Not a failure** |
| `BROKEN` | Re-run on this version, and it did not stand |

`SUSPECT` is the state that earns this its keep. It is the one nothing in the repo can
currently express, and it is the true state of almost everything anybody has ever built on
Bedrock.

## What it must not become

- **Not a home for an add-on's design.** A technique is "here is how this is done on
  Bedrock", never "here is how our mod works". If the reference implementation cannot be read
  by somebody who has never seen the consuming pack, it is in the wrong repository.
- **Not a claim without a version.** A technique with no version behind it is the rumour this
  is meant to replace. It should be impossible to record one.
- **Not a graveyard.** A technique that has been `BROKEN` on every supported version for a
  year is history, and should be said so plainly rather than left looking pending.
- **Never edited to go quiet.** Same house rule as everywhere else. A technique that stopped
  standing is a finding.

## Keep the failures

`SOLVING.md` already argues this about solves — "it took three shapes, and the two failures
are worth more than the working version." The same is more true here, because a technique's
failures are the arrangements a reader would otherwise try first. A technique that records
only its final shape has thrown away most of what it knows.

## The portfolio falls out of it

Once techniques carry a state per version, **the showcase is a report, not a curation
effort** — the same relationship `docs/CAPABILITIES.md` already has to the ledger. "What is
demonstrably doable on Bedrock 1.21.120, with a runnable example for each" is a query over
data that would already exist, and it is a far stronger artifact than a list of claims
because every row can be re-run by whoever is reading it.

That is also the honest answer to credibility. Not "we did this" — **"here is the smallest
thing that does it, here is what it rests on, here is the version it last stood up on, run
it yourself."**

## Open questions

- **Naming.** "Technique" is a placeholder. The repo's existing vocabulary is questions,
  probes, observations, solves — this may want a word from that family.
- **Where a reference implementation lives.** The probe pack is a probe pack; techniques may
  want their own pack, or may be probes with a different method. A technique whose test is
  just a probe is suspiciously close to `method: observed` with extra citation.
- **Whether `SUSPECT` needs a severity.** A technique citing eight capabilities where one
  tolerance-level `solved` value drifted is in a different situation from one whose
  load-bearing yes/no flipped.
- **Who re-runs.** `SUSPECT` accumulates for free and clears only at the cost of a server
  run. Without an owner it becomes a wall of yellow that everybody learns to ignore, which is
  the failure mode `physics.yaml` already warns about for tolerances.
