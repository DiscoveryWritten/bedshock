/**
 * The search that turns "does it hold at x?" into a number.
 *
 * THIS FILE IMPORTS NOTHING. Not `@minecraft/server`, not the emitter, not the pack. That is
 * deliberate and it is what makes it reusable: a solve is a state machine over trials, and
 * nothing about the state machine cares whether a trial is a falling anvil, an HTTP request or
 * an arithmetic function. It can be driven from a tick loop, from a test, or from a plain
 * in-memory measurement in somebody else's project.
 *
 * WHAT IT IS FOR. Some questions do not have a yes. "Can a script read an item's durability" has
 * one. "How close can a moving block pass beneath a falling anvil" does not — it has a boundary,
 * and the boundary is the answer. A boundary can be found by asking a yes/no question repeatedly
 * at different values, which is a bisection, which is this.
 *
 * THE THREE FAILURES IT IS BUILT TO REFUSE, because each of them produces a number that looks
 * exactly like a measurement:
 *
 *   1. THE TRIAL NEVER HELD. If the property fails even at the loose end of the range, there is
 *      no boundary in the range and a bisection will happily converge on `from` anyway. That is
 *      not a measurement of the game; it is usually a broken apparatus.
 *
 *   2. THE TRIAL ALWAYS HELD. Same in reverse. Converging on `to` records the edge of a search
 *      somebody chose, dressed up as a property of Bedrock.
 *
 *   3. THE ANSWER IS THE EDGE. Even with both bounds behaving, a solve that lands within one
 *      tolerance of the loose bound is reporting a boundary that is very likely outside the
 *      range. Widening the search would move it, and a number that moves when you change the
 *      question is not an answer.
 *
 * All three come back as INCONCLUSIVE with a reason, never as a value. INCONCLUSIVE here means
 * the apparatus did not answer — it is not a soft "no", and nothing downstream treats it as one.
 *
 * REPEATS ARE CONJUNCTIVE. `repeats: 3` means the trial must hold three times out of three to
 * count as holding at that x. Physics trials are noisy and the question being asked is almost
 * always "does this work RELIABLY at x", so one flake is a failure. A single failure
 * short-circuits the rest, which is also why the trial budget goes further than it looks.
 */

export type Direction = 'minimum' | 'maximum';

export interface SearchSpec {
  /** The ends of the range. `from` must be less than `to`. */
  from: number;
  to: number;
  /**
   * How near two values have to be before the difference between them stops being a finding.
   *
   * Set it from the apparatus's own resolution, not from how precise you would like to be. A
   * tolerance finer than the instrument reports DRIFT on noise forever, and a drift report
   * people learn to ignore is worse than no drift report.
   */
  tolerance: number;
  /**
   * Which end of the range the property is expected to hold at.
   *
   *   `minimum` — holds at `to`, fails at `from`; the answer is the SMALLEST value that holds.
   *   `maximum` — holds at `from`, fails at `to`; the answer is the LARGEST value that holds.
   */
  direction: Direction;
  /** How many times a trial must hold at one value to count as holding. Default 1. */
  repeats?: number;
  /** A hard ceiling on trials, so a nondeterministic trial cannot run forever. Default 80. */
  maxTrials?: number;
}

/** Run the trial at `x` and report back with `record()`. */
export interface Ask {
  done: false;
  x: number;
  /** `bound` while the ends are being confirmed, `narrow` once the bisection is running. */
  phase: 'bound' | 'narrow';
  /** Trials completed so far, not counting this one. */
  trial: number;
}

export interface Answer {
  done: true;
  /** `YES` means a boundary was found. Nothing here ever returns `NO` — see the file header. */
  verdict: 'YES' | 'INCONCLUSIVE';
  /** The converged value. Absent on INCONCLUSIVE, always, so it cannot be recorded by accident. */
  value?: number;
  /** The final bracket: the answer is known to be between these. */
  bracket: [number, number];
  trials: number;
  /** Plain language, and it goes in the ledger as evidence. */
  why: string;
}

export type Move = Ask | Answer;

export interface Search {
  /** The first value to try. */
  begin(): Move;
  /** Report whether the property held at the value just asked for; get the next one. */
  record(held: boolean): Move;
  /** Every trial and its outcome, in order. */
  history(): readonly { x: number; held: boolean }[];
}

const DEFAULT_REPEATS = 1;
const DEFAULT_MAX_TRIALS = 80;

export function bisect(spec: SearchSpec): Search {
  const repeats = Math.max(1, Math.floor(spec.repeats ?? DEFAULT_REPEATS));
  const maxTrials = Math.max(1, Math.floor(spec.maxTrials ?? DEFAULT_MAX_TRIALS));
  const log: { x: number; held: boolean }[] = [];

  const minimum = spec.direction === 'minimum';
  /** The end the property is expected to hold at. */
  const loose = minimum ? spec.to : spec.from;
  /** The end it is expected to fail at. */
  const tight = minimum ? spec.from : spec.to;

  let stage: 'loose' | 'tight' | 'narrow' | 'done' = 'loose';
  let at = loose;
  let left = repeats;
  let trials = 0;
  let holds = loose;
  let fails = tight;
  let answer: Answer | undefined;

  const bracket = (): [number, number] => [Math.min(holds, fails), Math.max(holds, fails)];

  const finish = (verdict: Answer['verdict'], why: string, value?: number): Answer => {
    stage = 'done';
    answer = {
      done: true,
      verdict,
      ...(value !== undefined ? { value } : {}),
      bracket: bracket(),
      trials,
      why,
    };
    return answer;
  };

  // A spec that cannot be searched is caught here rather than thrown, so a probe using a bad
  // spec still emits a row saying so. A thrown error would leave the capability ABSENT from the
  // log, which is indistinguishable from a question nobody asked.
  const span = spec.to - spec.from;
  if (!(span > 0)) {
    answer = finish('INCONCLUSIVE', `the search range is empty: from ${spec.from} to ${spec.to}`);
  } else if (!(spec.tolerance > 0)) {
    answer = finish('INCONCLUSIVE', `the tolerance must be above zero; got ${spec.tolerance}`);
  } else if (spec.tolerance >= span) {
    answer = finish(
      'INCONCLUSIVE',
      `the tolerance (${spec.tolerance}) is as wide as the search range (${span}), so any value ` +
        `in it would satisfy the search and none of them would mean anything`,
    );
  }

  const ask = (): Ask => ({ done: false, x: at, phase: stage === 'narrow' ? 'narrow' : 'bound', trial: trials });

  /** Choose the next value, or stop. */
  const step = (): Move => {
    if (Math.abs(holds - fails) <= spec.tolerance) {
      // Failure 3: the boundary sits on the edge of a range somebody chose.
      if (Math.abs(holds - loose) <= spec.tolerance) {
        return finish(
          'INCONCLUSIVE',
          `the solve converged on ${round(holds)}, which is the loose end of its own search range ` +
            `(${spec.from}..${spec.to}). The boundary is probably outside the range — widen it and ` +
            `re-run. A number that moves when you widen the search is not a measurement.`,
        );
      }
      return finish(
        'YES',
        `converged on ${round(holds)} after ${trials} trial(s); it held at ${round(holds)} and ` +
          `failed at ${round(fails)}, which is inside the tolerance of ${spec.tolerance}`,
        holds,
      );
    }
    if (trials >= maxTrials) {
      return finish(
        'INCONCLUSIVE',
        `ran out of trials (${maxTrials}) with the boundary still somewhere between ` +
          `${round(Math.min(holds, fails))} and ${round(Math.max(holds, fails))}. A half-narrowed ` +
          `bracket is a range, not a solve, and recording it as one would file a number nothing measured.`,
      );
    }
    at = (holds + fails) / 2;
    left = repeats;
    return ask();
  };

  return {
    begin(): Move {
      return answer ?? ask();
    },

    record(held: boolean): Move {
      if (answer) return answer;
      trials++;
      log.push({ x: at, held });

      // Conjunctive: one failure settles the value immediately, and the remaining repeats are
      // not worth spending on a question already answered.
      if (held) left--;
      else left = 0;
      const settled = !held || left === 0;
      if (!settled) return ask();

      switch (stage) {
        case 'loose':
          if (!held) {
            return finish(
              'INCONCLUSIVE',
              `the trial did not hold even at ${loose}, the loose end of the search. Either the ` +
                `property never holds anywhere in ${spec.from}..${spec.to}, or the apparatus failed. ` +
                `Bisecting anyway would converge on ${tight} and record the edge of the search as a finding.`,
            );
          }
          holds = loose;
          stage = 'tight';
          at = tight;
          left = repeats;
          return ask();

        case 'tight':
          if (held) {
            return finish(
              'INCONCLUSIVE',
              `the trial held even at ${tight}, the tight end of the search, so the boundary is ` +
                `outside ${spec.from}..${spec.to}. The bound is not the answer; it is where somebody ` +
                `stopped looking.`,
            );
          }
          fails = tight;
          stage = 'narrow';
          return step();

        default:
          if (held) holds = at;
          else fails = at;
          return step();
      }
    },

    history(): readonly { x: number; held: boolean }[] {
      return log;
    },
  };
}

/** Four decimals is past the resolution of anything measurable in a tick-based game. */
function round(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * How many trials a spec will take at most, so a caller can decide whether it fits in a run.
 *
 * Two bound checks plus the halvings needed to bring the range inside the tolerance, times the
 * repeats. It is an upper bound: a failing trial short-circuits its repeats, so real runs come
 * in under it.
 */
export function trialBudget(spec: SearchSpec): number {
  const repeats = Math.max(1, Math.floor(spec.repeats ?? DEFAULT_REPEATS));
  const span = spec.to - spec.from;
  if (!(span > 0) || !(spec.tolerance > 0)) return 0;
  return (2 + Math.ceil(Math.log2(span / spec.tolerance))) * repeats;
}
