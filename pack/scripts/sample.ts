/**
 * Turning several readings of the same thing into one number, or refusing to.
 *
 * THIS FILE IMPORTS NOTHING, for the same reason `bisect.ts` does not: the arithmetic of "I
 * measured this five times, what is the answer" has nothing to do with Minecraft, and a project
 * measuring something in memory should get the same discipline as one measuring a thrown item.
 *
 * THE SECOND SHAPE A SOLVED ROW COMES IN. `bisect.ts` finds a BOUNDARY: a yes/no trial asked
 * repeatedly until the edge is bracketed. This is the other one — a DIRECT MEASUREMENT, where
 * the apparatus hands back a number every time and the only question is whether those numbers
 * agree well enough to be called an answer.
 *
 * Both end up in the same place: one value, one tolerance, one row that reports when the game's
 * constants move. What differs is how you get there, and conflating them is how a measurement
 * gets dressed up as a search or vice versa.
 *
 * THE REFUSALS, and they exist because every one of them otherwise produces a plausible number:
 *
 *   THE READINGS DISAGREE. If five throws land 4 blocks apart and the tolerance is 0.25, there
 *   is no single number here — recording the mean would file a value that no run will reproduce
 *   and that will report DRIFT against itself forever.
 *
 *   TOO MANY READINGS FAILED. An apparatus that works two times in five is not an apparatus that
 *   works. The survivors might agree perfectly and mean nothing.
 *
 *   A READING LANDED OUTSIDE THE PLAUSIBLE RANGE. The catalog's `search` bounds say what an
 *   answer could possibly be. A thrown item reporting 900 blocks did not travel 900 blocks; it
 *   fell down a ravine, or the origin moved, or the entity being watched was not the one thrown.
 *
 * THE VALUE IS THE MEDIAN, not the mean. One reading that went down a hole should not move the
 * answer at all, and with five samples a mean lets it move the answer by a fifth of the error.
 */

export interface SampleSpec {
  /** How many readings to take. */
  samples: number;
  /**
   * How far individual readings may disagree before there is no single number here.
   *
   * NOT the same as the capability's tolerance, and the difference matters. Tolerance is how
   * much the ANSWER may move between runs before it is a finding. This is how much one READING
   * may scatter within a run — and since the answer is a median of several, its scatter is
   * smaller than theirs. An apparatus is allowed to be noisier than the tolerance provided it
   * takes enough samples to average down below it, which is a rule worth checking rather than
   * hoping for.
   */
  spread: number;
  /** A reading outside this is the apparatus, not the game. Usually the catalog's `search`. */
  range?: { from: number; to: number };
}

export interface Summary {
  /** `YES` means there is a number. Nothing here ever returns `NO`. */
  verdict: 'YES' | 'INCONCLUSIVE';
  /** The median of the surviving readings. Absent on INCONCLUSIVE, always. */
  value?: number;
  /** The readings that counted, in the order they were taken. */
  kept: number[];
  /** How many were thrown away, and why they were. */
  failed: number;
  rejected: number;
  /** The observed scatter of what survived. */
  observed: number;
  why: string;
}

export function summarise(readings: readonly (number | null)[], spec: SampleSpec): Summary {
  const attempted = readings.length;
  const failed = readings.filter((r) => r === null || !Number.isFinite(r)).length;

  const inRange = (v: number): boolean =>
    !spec.range || (v >= spec.range.from && v <= spec.range.to);

  const numbers = readings.filter((r): r is number => r !== null && Number.isFinite(r));
  const kept = numbers.filter(inRange);
  const rejected = numbers.length - kept.length;
  const observed = kept.length ? Math.max(...kept) - Math.min(...kept) : 0;

  const base: Omit<Summary, 'verdict' | 'why'> = { kept, failed, rejected, observed };
  const no = (why: string): Summary => ({ verdict: 'INCONCLUSIVE', ...base, why });

  // A majority has to survive. Two good readings out of nine agreeing perfectly is not a
  // measurement of anything except the two times the rig happened to work.
  if (kept.length < 2 || kept.length * 2 <= attempted) {
    const bits = [
      failed ? `${failed} reading(s) failed outright` : '',
      rejected && spec.range
        ? `${rejected} landed outside the plausible range of ${spec.range.from}..${spec.range.to}`
        : '',
    ].filter(Boolean);
    return no(
      `only ${kept.length} of ${attempted} reading(s) survived${bits.length ? ` — ${bits.join(', ')}` : ''}. ` +
        `A number from a rig that mostly does not work is a number about the rig.`,
    );
  }

  if (observed > spec.spread) {
    return no(
      `the readings scatter by ${round(observed)}, past the ${spec.spread} this apparatus is ` +
        `allowed — so there is no single number here. Recording the middle of them would file a ` +
        `value no run reproduces, which then reports drift against itself forever.`,
    );
  }

  const noise = [
    failed ? `${failed} failed` : '',
    rejected ? `${rejected} out of range` : '',
  ].filter(Boolean);

  return {
    verdict: 'YES',
    value: round(median(kept)),
    ...base,
    why:
      `median of ${kept.length} reading(s), scattering ${round(observed)} ` +
      `(allowed ${spec.spread})${noise.length ? `; ${noise.join(', ')}` : ''}`,
  };
}

/** The middle reading. Even counts average the two middles, which is the usual convention. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Roughly how much the MEDIAN of `samples` readings will itself move between runs.
 *
 * Scatter averages down with the square root of the count, so an apparatus whose readings are
 * noisier than the tolerance can still produce a stable answer — if it takes enough of them.
 * This is what says how many is enough, and it is meant to be checked against the capability's
 * tolerance rather than hoped about: an apparatus whose median moves further than the tolerance
 * reports DRIFT on its own noise, every run, forever.
 */
export function medianScatter(spec: SampleSpec): number {
  if (spec.samples < 1) return Infinity;
  return spec.spread / Math.sqrt(spec.samples);
}

function round(n: number): number {
  return Number(n.toFixed(4));
}
