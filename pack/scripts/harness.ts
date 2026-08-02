/**
 * THE ENTRY POINT FOR SOMEBODY ELSE'S PACK.
 *
 * Everything else under `pack/scripts/` is this repository's own instruments, and they will move.
 * This module is the contract: import it from your own behaviour pack, write your own trial, and
 * your numbers come out in the same shape ours do — same wire format, same collector, same
 * ledger, same report with the same log scale down the same column.
 *
 *     import { solve, result, look, skipped, done, begin } from '../vendor/bedshock/pack/scripts/harness.ts';
 *
 * WHY THIS EXISTS RATHER THAN "GO READ OUR PROBES". A capability battery is only half a
 * capability battery. The other half is every project's own questions, which nobody else can
 * write, because they are about that project's own code:
 *
 *   - how much upward boost a horizontal portal has to give to clear the floor on exit
 *   - the speed above which something crossing a trigger volume is never seen inside it
 *   - how many entities a per-tick scan survives before the frame budget goes
 *
 * None of those belong in bedshock's catalog. All of them are the same KIND of question as the
 * ones that do: a boundary, found by asking a yes/no trial repeatedly, worth recording per
 * Minecraft version because the answer moves when the engine does. So the apparatus is the part
 * worth sharing, and the questions are the part worth keeping.
 *
 * WHAT YOU GET.
 *
 *   `solve`      a bisection driven across ticks, with the three ways a search lies about
 *                itself already refused. See `solve.ts` and `bisect.ts`.
 *   `bisect`     the same search with no Minecraft in it, if your trial is not a tick loop —
 *                an in-memory measurement, a test, a replay.
 *   `result`     one measured answer, on the wire the collector reads.
 *   `look`       something is on a screen and only a person can grade it. Never a pass.
 *   `skipped`    why a probe did nothing, so an absent row is never mistaken for a finding.
 *   `begin`/`done`  the run markers. A log with no `DONE` is refused wholesale, because a
 *                prefix of a run recorded as a run is a ledger full of confident negatives
 *                about things nobody measured.
 *
 * WHAT YOU STILL HAVE TO WRITE. A catalog of your own — one YAML file with your questions in it
 * — and a ledger of your own to put the answers in. Point `BEDSHOCK_CATALOG` and
 * `BEDSHOCK_LEDGER` at them and every command in this repository works on your questions instead
 * of ours. `bedshock init` writes a working one to start from; `docs/SOLVING.md` is the walk
 * through.
 *
 * TWO RULES SURVIVE INTO YOUR PACK, and they are not stylistic.
 *
 *   A capability id you report must exist in the catalog you collect against, or the result is
 *   dropped on the floor with a warning. That is deliberate: a typo that silently recorded would
 *   be a measurement filed under a question nobody asked.
 *
 *   A probe that answers on a timer must claim `willReportLater`. `DONE` stops the harness the
 *   moment it prints, and a probe still counting ticks has its row thrown away with the server —
 *   absent, which reads the same as never asked. `solve` claims it for you.
 */

export { bisect, trialBudget } from './bisect.ts';
export type { Answer, Ask, Direction, Move, Search, SearchSpec } from './bisect.ts';

export { solve } from './solve.ts';
export type { Settle, SolveSpec, Trial } from './solve.ts';

export {
  begin,
  claimTickingArea,
  done,
  firstLine,
  HEADLESS_AT,
  look,
  makeCtx,
  result,
  skipped,
  whenChunkIsLive,
  willReportLater,
} from './emit.ts';
export type { Ctx, Verdict } from './emit.ts';
