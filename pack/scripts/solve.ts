/**
 * Driving a search across ticks, and reporting the number it lands on.
 *
 * `bisect.ts` decides which value to try next; this decides WHEN, because a trial in Minecraft
 * is not a function call. Dropping a block takes as long as the fall, and a trial that returns
 * immediately has measured nothing.
 *
 * The whole file is three guarantees, and each of them exists because the failure it prevents
 * produces a plausible-looking number rather than an error:
 *
 *   THE ROW IS ALWAYS EMITTED. `willReportLater` is claimed before the first trial and released
 *   on every exit path, including the ones nobody planned. A solve that dies quietly leaves its
 *   capability ABSENT from the log, which reads the same as a question the battery never asked.
 *
 *   A TRIAL THAT NEVER ANSWERS IS NOT A FAILED TRIAL. If a trial forgets to settle, treating it
 *   as `false` would feed the bisection a fabricated result and converge on a fabricated number.
 *   It stops the whole solve as INCONCLUSIVE and names the trial that hung.
 *
 *   THE APPARATUS CAN SAY SO. `settle(null)` means the trial could not tell — the anvil never
 *   spawned, the chunk went away, the entity vanished before it was seen. That is different from
 *   the property failing, and collapsing the two is how a bisection converges on the behaviour of
 *   a bug in the probe.
 *
 * WRITING YOUR OWN. This is exported from `bedshock/harness` and is meant to be used from
 * another pack. See `docs/SOLVING.md`; the short version is that you need a trial, a range, and
 * a tolerance taken from your own instrument's resolution.
 */

import { system } from '@minecraft/server';

import { bisect, trialBudget, type Answer, type SearchSpec } from './bisect.ts';
import { result, willReportLater, type Ctx } from './emit.ts';

/**
 * Report whether the property held at the value being tried.
 *
 * `null` means the apparatus failed and the trial has no opinion — never use it for "no".
 * `note` is carried into the evidence when it decides the outcome, so a solve that fell over can
 * be diagnosed from a log rather than from a re-run.
 */
export type Settle = (held: boolean | null, note?: string) => void;

/** Run one trial at `x`, then call `settle` exactly once. May take as many ticks as it needs. */
export type Trial = (x: number, settle: Settle) => void;

export interface SolveSpec extends SearchSpec {
  /** The capability id the number is recorded against. */
  capability: string;
  /** The probe name, for the completion wait and for the log. */
  probe: string;
  /** Carried into the measurement so a reader of the raw ledger is not guessing. */
  unit?: string;
  /** Ticks to let the world settle between trials. */
  cooldown?: number;
  /** Ticks a single trial may take before the solve gives up on it. */
  trialTimeout?: number;
}

const DEFAULT_COOLDOWN = 10;
const DEFAULT_TRIAL_TIMEOUT = 200;

export function solve(ctx: Ctx, spec: SolveSpec, trial: Trial): void {
  const search = bisect(spec);
  const reported = willReportLater(spec.probe);
  let finished = false;

  const emit = (answer: Answer, note?: string): void => {
    if (finished) return;
    finished = true;
    reported();
    result(
      ctx,
      spec.capability,
      answer.verdict,
      {
        bracket: answer.bracket,
        trials: answer.trials,
        direction: spec.direction,
        tolerance: spec.tolerance,
        searched: [spec.from, spec.to],
        ...(spec.unit ? { unit: spec.unit } : {}),
        ...(spec.repeats ? { repeats: spec.repeats } : {}),
        // Bounded: a long solve's full history is noise in a ledger line, and the shape of the
        // search is readable from the first two dozen trials.
        history: search.history().slice(0, 24),
      },
      note ? `${answer.why} (${note})` : answer.why,
      answer.value,
    );
  };

  const advance = (move: ReturnType<typeof search.begin>): void => {
    if (move.done) {
      emit(move);
      return;
    }

    let answered = false;
    let waited = 0;
    const timeout = spec.trialTimeout ?? DEFAULT_TRIAL_TIMEOUT;

    const watchdog = system.runInterval(() => {
      waited += 2;
      if (answered || waited < timeout) return;
      system.clearRun(watchdog);
      answered = true;
      // Deliberately not recorded as a failure. A hung trial is an unknown, and feeding an
      // unknown to the bisection as `false` is how a solve converges on a number the game never
      // produced.
      emit(
        {
          done: true,
          verdict: 'INCONCLUSIVE',
          bracket: [spec.from, spec.to],
          trials: move.trial,
          why:
            `the trial at ${Number(move.x.toFixed(4))} never reported back within ${timeout} ticks. ` +
            `Nothing is recorded: a trial that did not answer is not a trial that failed.`,
        },
      );
    }, 2);

    const settle: Settle = (held, note) => {
      // A trial that settles twice would have its second answer applied to the NEXT value, which
      // silently corrupts the search rather than breaking it.
      if (answered) return;
      answered = true;
      system.clearRun(watchdog);

      if (held === null) {
        emit(
          {
            done: true,
            verdict: 'INCONCLUSIVE',
            bracket: [spec.from, spec.to],
            trials: move.trial,
            why: `the apparatus failed at ${Number(move.x.toFixed(4))}, so there is no boundary to report`,
          },
          note,
        );
        return;
      }

      const next = search.record(held);
      const cooldown = spec.cooldown ?? DEFAULT_COOLDOWN;
      if (next.done || cooldown <= 0) {
        advance(next);
        return;
      }
      system.runTimeout(() => advance(next), cooldown);
    };

    try {
      trial(move.x, settle);
    } catch (err) {
      if (answered) return;
      answered = true;
      system.clearRun(watchdog);
      emit(
        {
          done: true,
          verdict: 'INCONCLUSIVE',
          bracket: [spec.from, spec.to],
          trials: move.trial,
          why: `the trial at ${Number(move.x.toFixed(4))} threw`,
        },
        String(err).split('\n')[0],
      );
    }
  };

  ctx.say(
    `§7solving§r ${spec.capability} over ${spec.from}..${spec.to} ${spec.unit ?? ''} ` +
      `(up to ${trialBudget(spec)} trials)`,
  );
  advance(search.begin());
}
