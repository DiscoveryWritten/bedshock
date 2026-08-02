/**
 * Taking several readings across ticks, and reporting the number they agree on.
 *
 * The sibling of `solve.ts`, and the pair of them is the whole toolkit. `solve` asks a yes/no
 * trial repeatedly to find a BOUNDARY; `measure` asks an apparatus for a NUMBER several times
 * and reports what they agree on. Both emit one value on one wire format against one capability,
 * so a report cannot tell which was used and does not need to.
 *
 * WHICH ONE YOU WANT is decided by what your apparatus can hand back. If it can only tell you
 * whether something worked, you have a boundary and you want `solve`. If it hands you a
 * distance, a tick count, a velocity, you have a measurement and you want this. Forcing a
 * measurement through a bisection wastes trials and throws away the number; forcing a boundary
 * through a measurement invents one.
 *
 * The three guarantees are the same as `solve`'s, for the same reasons, and they are repeated
 * rather than shared because each is one line and a shared abstraction would hide them:
 *
 *   THE ROW IS ALWAYS EMITTED. `willReportLater` is claimed before the first reading and released
 *   on every exit. A row that vanishes is indistinguishable from a question nobody asked.
 *
 *   A READING THAT NEVER ANSWERS IS NOT A FAILED READING. It stops the run and names itself,
 *   rather than being recorded as a zero or silently skipped.
 *
 *   THE APPARATUS CAN SAY SO. `record(null)` means this reading did not happen. That is not the
 *   same as a reading of zero, and collapsing the two puts a fabricated number in the set.
 */

import { system } from '@minecraft/server';

import { summarise, type SampleSpec, type Summary } from './sample.ts';
import { result, willReportLater, type Ctx } from './emit.ts';

/**
 * Report one reading.
 *
 * `null` means this reading did not happen — the entity never spawned, the arena was not there,
 * something threw. Never use it for "the answer was zero", which is a perfectly good reading.
 */
export type Record = (value: number | null, note?: string) => void;

/** Take one reading, then call `record` exactly once. May take as many ticks as it needs. */
export type Reading = (index: number, record: Record) => void;

export interface MeasureSpec extends SampleSpec {
  /** The capability id the number is recorded against. */
  capability: string;
  /** The probe name, for the completion wait and for the log. */
  probe: string;
  /** Carried into the measurement so a reader of the raw ledger is not guessing. */
  unit?: string;
  /** Ticks to let the world settle between readings. */
  cooldown?: number;
  /** Ticks a single reading may take before the run gives up on it. */
  readingTimeout?: number;
}

const DEFAULT_COOLDOWN = 10;
const DEFAULT_READING_TIMEOUT = 200;

export function measure(ctx: Ctx, spec: MeasureSpec, take: Reading): void {
  const reported = willReportLater(spec.probe);
  const readings: (number | null)[] = [];
  // Kept beside the readings so a refusal can carry the apparatus's own account of why. Losing
  // these cost a real run: five readings failed, the summary said "5 failed", and the five
  // sentences explaining it went nowhere.
  const notes: (string | undefined)[] = [];
  let finished = false;

  const emit = (summary: Summary, note?: string): void => {
    if (finished) return;
    finished = true;
    reported();
    result(
      ctx,
      spec.capability,
      summary.verdict,
      {
        readings: summary.kept,
        attempted: readings.length,
        failed: summary.failed,
        rejected: summary.rejected,
        observed_spread: summary.observed,
        allowed_spread: spec.spread,
        ...(spec.unit ? { unit: spec.unit } : {}),
        ...(spec.range ? { plausible: [spec.range.from, spec.range.to] } : {}),
      },
      note ? `${summary.why} (${note})` : summary.why,
      summary.value,
    );
  };

  /** Stop early, without pretending the readings not taken were anything. */
  const abandon = (why: string, note?: string): void => {
    emit(
      {
        verdict: 'INCONCLUSIVE',
        kept: [],
        failed: readings.length,
        rejected: 0,
        observed: 0,
        why,
      },
      note,
    );
  };

  const next = (index: number): void => {
    if (index >= spec.samples) {
      emit(summarise(readings, spec, notes));
      return;
    }

    let answered = false;
    let waited = 0;
    const timeout = spec.readingTimeout ?? DEFAULT_READING_TIMEOUT;

    const watchdog = system.runInterval(() => {
      waited += 2;
      if (answered || waited < timeout) return;
      system.clearRun(watchdog);
      answered = true;
      // Deliberately not recorded as a failed reading and quietly carried on from. A reading
      // that hung means the apparatus is stuck, and the remaining samples would hang the same
      // way while the run's time budget drained.
      abandon(
        `reading ${index + 1} of ${spec.samples} never reported back within ${timeout} ticks. ` +
          `Nothing is recorded: a reading that did not answer is not a reading of zero.`,
      );
    }, 2);

    const record: Record = (value, note) => {
      // A second call would land on the NEXT reading's slot, which corrupts the set rather than
      // breaking it.
      if (answered) return;
      answered = true;
      system.clearRun(watchdog);

      readings.push(value === null || !Number.isFinite(value as number) ? null : value);
      notes.push(note);
      if (note) ctx.say(`§8  reading ${index + 1}: ${value === null ? 'failed' : value} — ${note}§r`);

      const cooldown = spec.cooldown ?? DEFAULT_COOLDOWN;
      if (cooldown <= 0) {
        next(index + 1);
        return;
      }
      system.runTimeout(() => next(index + 1), cooldown);
    };

    try {
      take(index, record);
    } catch (err) {
      if (answered) return;
      answered = true;
      system.clearRun(watchdog);
      abandon(`reading ${index + 1} threw`, String(err).split('\n')[0]);
    }
  };

  ctx.say(
    `§7measuring§r ${spec.capability} — ${spec.samples} reading(s), ` +
      `scatter up to ${spec.spread} ${spec.unit ?? ''}`,
  );
  next(0);
}
