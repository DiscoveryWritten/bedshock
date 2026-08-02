/**
 * The two data shapes this whole repository is built around, and the line between them.
 *
 * A CAPABILITY is a question about Bedrock. It is written by hand, it lives in
 * `content/capabilities/*.yaml`, and it never contains an answer. A capability is the same
 * on every Minecraft version — that is what makes it worth naming.
 *
 * An OBSERVATION is one answer to one capability on one version, from one run. It is
 * append-only, it lives in `ledger/observations.jsonl`, and nothing ever edits one. A
 * capability that stops being true does not get its old observation corrected; it gets a new
 * one, and the disagreement between them is the finding.
 *
 * Everything else here — the report, the drift check, the build-time assertion — is a
 * projection of those two. `docs/CAPABILITIES.md` is generated and should never be edited by
 * hand, which is the single largest difference from the document this repository grew out of.
 */

// ---------------------------------------------------------------------------
// Capabilities — the questions
// ---------------------------------------------------------------------------

/**
 * How an answer can be arrived at, and it is not a detail.
 *
 * `automated` means the script API can decide it with no interpretation: whether a component
 * reports the number it was given, whether a dynamic property survives a round trip, whether
 * an entity's container accepts a write. These run headless on a dedicated server, so they
 * cost nothing and can run on every version without a human.
 *
 * `observed` means only a person looking at a screen can answer: which pixel rows a bar
 * covers, whether a glyph is coloured, whether four flags render. The battery's job for these
 * is to set the scene exactly and enumerate the outcomes — never to guess the result.
 *
 * `derived` means it was established well enough by reading what we emit, or by the absence
 * of an API, that spending a probe slot on it would be theatre. Recorded so nobody
 * re-derives it, and so a future contradiction is visible as a contradiction.
 */
export type Method = 'automated' | 'observed' | 'derived';

/**
 * The three things an answer can be, and the third one is load-bearing.
 *
 * `INCONCLUSIVE` is not a soft `NO`. It is the verdict for a run where the apparatus itself
 * could not be trusted — a control that did not draw, a rig too small to read, a probe that
 * measured the instrument rather than the game. Collapsing it into `NO` is how a battery
 * starts producing confident-looking answers to questions it never asked.
 */
export type Verdict = 'YES' | 'NO' | 'INCONCLUSIVE';

/**
 * One outcome a person can pick when answering an `observed` capability.
 *
 * Declaring these up front is the whole mechanism. `docs/CAPABILITIES.md` in the host repo
 * already demanded that every eyes-only probe say "what to expect, and how to tell two
 * outcomes apart" — but it said it in prose, so nothing checked that the answer written down
 * afterwards came from that set. Here the set is data: `bedshock amend` offers exactly these
 * and records the id, so an answer is always traceable to a distinction the probe was
 * designed to make.
 *
 * The P3b rig is the cautionary tale. Its two candidate readings were "the query is live" and
 * "the query is blind", and for two sessions those produced a pixel-identical picture — an
 * answer space with a collision in it. Writing the outcomes down before running is what
 * surfaces that.
 */
export interface Outcome {
  /** Stable id. This is what lands in the ledger, so renaming one rewrites history. */
  id: string;
  /** What the person picks off a list. Should describe what they SEE, not what it means. */
  label: string;
  /** What that sighting settles. */
  verdict: Verdict;
  /** Why that sighting means that. Shown under the label while choosing. */
  means?: string;
}

export interface Capability {
  /**
   * Dotted, domain-first, and stable forever: `item.max_durability.int16_ceiling`.
   *
   * Host packs cite these ids in source comments and the build fails on a citation that does
   * not resolve, so an id is a public interface. Renaming one is a breaking change to every
   * repository that depends on this battery.
   */
  id: string;
  /** The question, phrased so that YES and NO are both meaningful answers. */
  question: string;
  /**
   * Which decision this blocks.
   *
   * Required, and the requirement is deliberate: a capability with no decision behind it is a
   * capability nobody will read the result of. If this is hard to fill in, the row probably
   * does not belong in the battery yet.
   */
  decides: string;
  method: Method;
  /**
   * Which probe reports this, for `automated` and `observed` rows.
   *
   * Many-to-one on purpose. One apparatus routinely settles several propositions at once —
   * the container probe alone answers whether storage works, whether a `horse` container
   * opens, whether a `chest` one does, and whether the slots are typed. Those are four
   * verdicts with four independent lifetimes, and giving them one row each is what lets three
   * of them go quiet while the fourth stays open.
   */
  probe?: string;
  /** What the person should be looking at. `observed` only. */
  look_at?: string;
  /** The enumerated answer space. `observed` only, and required there. */
  outcomes?: Outcome[];
  /**
   * For `derived` rows: where the conclusion came from. A file we emit, a missing API, a
   * documented engine behaviour. Not a measurement, and the report says so.
   */
  established_by?: string;
  /**
   * Capability ids this one only makes sense downstream of.
   *
   * The bisect floor, made machine-readable. A rig that stays dark cannot say whether
   * attachables work on custom items at all, so `render.attachable.reads_item_durability`
   * depends on `render.attachable.on_custom_item` — and the report refuses to present the
   * former as settled while the latter is open.
   */
  depends_on?: string[];
  /** Free-form. `P1`, `P11` — the probe numbers this row arrived under, for citations. */
  legacy?: string;
  /** Prose that belongs in the generated report under this row. */
  notes?: string;
}

export interface CapabilityFile {
  domain: string;
  /** One paragraph on what this domain covers, printed as the section preamble. */
  about?: string;
  capabilities: Capability[];
}

// ---------------------------------------------------------------------------
// Observations — the answers
// ---------------------------------------------------------------------------

/**
 * Where an answer came from. Not the same axis as `Method`: an automated capability can be
 * answered from a client if someone runs the battery there, and both are legitimate.
 */
export type Platform = 'bds' | 'client' | 'imported';

export interface Observation {
  /** Must resolve against the catalog. `bedshock validate` fails on one that does not. */
  capability: string;
  /**
   * The Minecraft version this was true on, as the game reports it: `1.21.120`.
   *
   * The axis this whole repository exists to add. A capability is not true or false; it is
   * true or false ON A VERSION, and the interesting moment is the one where that changes.
   */
  version: string;
  /** The script API surface present during the run, e.g. `@minecraft/server 2.3.0`. */
  api?: string;
  platform: Platform;
  method: Method;
  verdict: Verdict;
  /** The `Outcome.id` picked, for `observed` rows. Absent for automated ones. */
  outcome?: string;
  /**
   * What the probe actually saw, structured.
   *
   * This is what makes drift detection worth anything. A boolean verdict can agree across two
   * runs while the numbers underneath it move — the durability ceilings are the case in
   * point: every declared value reporting itself is a YES, and 32768 coming back as -32768 is
   * ALSO part of that YES. Comparing verdicts alone would miss a change from -32768 to 32767,
   * which is precisely the change that would matter.
   */
  measurement?: Record<string, unknown>;
  /** One line of prose from whoever or whatever recorded this. */
  evidence?: string;
  /** A human's free-text note from `bedshock amend`. Never load-bearing, often the useful bit. */
  note?: string;
  /** Groups every observation from one battery run. */
  run: string;
  /** ISO 8601. */
  at: string;
}

// ---------------------------------------------------------------------------
// Status — the rollup
// ---------------------------------------------------------------------------

/**
 * What a capability is, on a given version, given everything the ledger knows.
 *
 * Derived rather than stored. There is no field anywhere that says `SETTLED`; there are only
 * observations, and this is a function of them. That is the fix for the failure mode the host
 * repo warned about loudest — an expectation edited to make a probe quiet. Here there is
 * nothing to edit: to change a status you have to add a measurement.
 */
export type Status =
  /** Measured, and the answer is yes. Build on it, cite it. */
  | 'SETTLED'
  /** Measured, and the answer is no. The idea is dead; the row exists so nobody reproposes it. */
  | 'CLOSED-NEGATIVE'
  /** Never measured on this version. A plan resting on this needs a fallback. */
  | 'OPEN'
  /** Measured, and the apparatus could not be trusted. Not a soft no — the probe needs work. */
  | 'INCONCLUSIVE'
  /**
   * Two runs on the SAME version disagree.
   *
   * The loudest verdict, and the only one that means this document is now wrong. Either the
   * game changed under a version number, or a probe was edited into lying. Both are worth
   * stopping for.
   */
  | 'DRIFT'
  /** Settled downstream of something still open. The answer may be measuring the instrument. */
  | 'UNDERMINED';

export interface CapabilityStatus {
  capability: Capability;
  version: string;
  status: Status;
  /** Most recent first. */
  observations: Observation[];
  /** Populated for `DRIFT` and `UNDERMINED`: what specifically is wrong. */
  conflict?: string;
}
