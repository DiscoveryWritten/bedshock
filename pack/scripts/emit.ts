/**
 * The wire format between the game and the ledger.
 *
 * Every result leaves the game as one line on `console.warn`, which is what a Bedrock
 * Dedicated Server writes to its log and what `tools/run.ts` reads back. The format is
 * deliberately boring — a tag, a capability id, a verdict, and a JSON blob — because the thing
 * on the other end is a grep, and a grep that half-matches is worse than one that does not
 * match at all.
 *
 *   BEDSHOCK RESULT <capability.id> <YES|NO|INCONCLUSIVE> <json>
 *   BEDSHOCK LOOK   <capability.id> <what is now on your screen>
 *   BEDSHOCK NOTE   <probe> <anything a person reading the log should know>
 *   BEDSHOCK DONE   <count>
 *
 * `LOOK` IS NOT A RESULT, and the separation is the whole discipline. A probe whose answer is
 * on a screen has no verdict until someone looks, and a battery that quietly grades its own
 * eyes-only rows is a battery that produces confident answers to questions it never asked.
 * `run.ts` records `RESULT` lines and refuses to record `LOOK` lines; the only path from a
 * `LOOK` to the ledger runs through a person in `bedshock amend`.
 *
 * `DONE` is printed last, so its presence means the whole battery ran rather than that the
 * handler merely fired. A run that never prints it is a run that measured nothing, and that
 * must never be recorded as a set of negative results.
 */

import { system, world, type Player } from '@minecraft/server';

export const TAG = 'BEDSHOCK';

export type Verdict = 'YES' | 'NO' | 'INCONCLUSIVE';

export interface Ctx {
  player?: Player;
  /** Chat gets colour codes; the log gets them stripped. */
  say(text: string): void;
}

let count = 0;

const strip = (text: string): string => text.replace(/§./g, '');

export function makeCtx(player?: Player): Ctx {
  return {
    ...(player ? { player } : {}),
    say(text: string) {
      player?.sendMessage(`§b[${TAG}]§r ${text}`);
      console.warn(`${TAG} NOTE ${strip(text)}`);
    },
  };
}

/**
 * A measured answer. `measurement` is what the probe actually saw, and it is not optional
 * decoration: a verdict can hold steady across two runs while the numbers underneath it move,
 * and the ledger compares both. The durability ceilings are the case in point — every declared
 * value reporting itself is a YES either way, and a change from "32768 wraps negative" to
 * "32768 clamps" would keep that YES while invalidating the design it was measured for.
 */
export function result(
  ctx: Ctx,
  capability: string,
  verdict: Verdict,
  measurement?: Record<string, unknown>,
  evidence?: string,
  /**
   * For a `solved` capability: the value the search converged on.
   *
   * Separate from `measurement` because the ledger compares it numerically against the
   * capability's tolerance. A number buried in a measurement blob is a number nothing can drift
   * against, and drifting on it is the entire reason these rows exist.
   */
  value?: number,
): void {
  count++;
  const payload = JSON.stringify({
    ...(value !== undefined ? { value } : {}),
    ...(measurement ? { measurement } : {}),
    ...(evidence ? { evidence } : {}),
  });
  console.warn(`${TAG} RESULT ${capability} ${verdict} ${payload}`);
  const colour = verdict === 'YES' ? '§a' : verdict === 'NO' ? '§c' : '§e';
  const shown = value === undefined ? '' : `§f${value}§r `;
  ctx.player?.sendMessage(`§b[${TAG}]§r ${colour}${verdict}§r §7${capability}§r ${shown}${evidence ?? ''}`);
}

/** Something is now on your screen and only you can read it. Never a pass. */
export function look(ctx: Ctx, capability: string, what: string): void {
  count++;
  console.warn(`${TAG} LOOK ${capability} ${strip(what)}`);
  ctx.player?.sendMessage(`§b[${TAG}]§r §6LOOK§r §7${capability}§r ${what}`);
}

/**
 * One line explaining why a probe did nothing, rather than omitting it.
 *
 * A silently absent probe is indistinguishable from a probe that ran and found nothing, and
 * only one of those is a finding.
 */
export function skipped(ctx: Ctx, capability: string, why: string): void {
  console.warn(`${TAG} SKIP ${capability} ${why}`);
  ctx.player?.sendMessage(`§b[${TAG}]§r §8skip§r §7${capability}§r ${why}`);
}

/**
 * The first line of an error, which is the part that names it.
 *
 * Bedrock's stack traces are long and the useful token is always at the front — the error
 * CLASS. `LocationInUnloadedChunkError` is the difference between a finding and a probe that
 * measured the instrument, and a truncated trace that dropped it has cost a reading before.
 */
export function firstLine(err: unknown): string {
  return String(err).split('\n')[0] ?? String(err);
}

export function begin(): void {
  count = 0;
  pending = 0;
  console.warn(`${TAG} BEGIN ${new Date().toISOString()}`);
}

// ---------------------------------------------------------------------------
// Probes that cannot answer in one tick
// ---------------------------------------------------------------------------

/**
 * Some measurements ARE the passage of time and cannot be squeezed into one tick. Whether the
 * client ejects an off-hand item takes seconds by construction; watching a block fall takes as
 * long as the fall.
 *
 * Which creates a trap the first CI run walked straight into. `DONE` is the marker the harness
 * waits on, and it stops the server the moment it appears — so a probe still counting ticks
 * when `DONE` printed had its result thrown away with the server. The row was then ABSENT from
 * the log: not a pass, not a fail, not even a skip, just gone. And an absent row is the one
 * thing this battery must never produce silently, because absence is indistinguishable from a
 * question nobody asked.
 *
 * So a probe that will report later says so, and `done()` waits for it.
 */
let pending = 0;
const outstanding = new Set<string>();

export function willReportLater(probe: string): () => void {
  pending++;
  outstanding.add(probe);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending--;
    outstanding.delete(probe);
  };
}

/**
 * Print `DONE`, once nothing is still counting ticks.
 *
 * The timeout is a backstop rather than a schedule: if a probe never releases, waiting forever
 * would hang the harness until ITS timeout, and a run killed from outside reports nothing at
 * all. So the wait is bounded and what did not report is NAMED — a reader sees which rows are
 * missing and why, rather than inferring it from a gap.
 */
export function done(ctx: Ctx, timeoutTicks = 300): void {
  const finish = (): void => {
    if (outstanding.size > 0) {
      const names = [...outstanding].join(', ');
      console.warn(
        `${TAG} NOTE ${outstanding.size} probe(s) never reported back: ${names}. ` +
          `Those rows are ABSENT, not negative.`,
      );
      ctx.player?.sendMessage(`§b[${TAG}]§r §e${outstanding.size} probe(s) never reported: ${names}§r`);
    }
    ctx.say(`§l---§r battery complete: ${count} line(s). Eyes-only rows are recorded by \`bedshock amend\`.`);
    console.warn(`${TAG} DONE ${count}`);
  };

  if (pending === 0) {
    finish();
    return;
  }

  let waited = 0;
  const handle = system.runInterval(() => {
    waited += 2;
    if (pending > 0 && waited < timeoutTicks) return;
    system.clearRun(handle);
    finish();
  }, 2);
}

// ---------------------------------------------------------------------------
// Getting a chunk to exist
// ---------------------------------------------------------------------------

/**
 * Where a headless run puts things, and why claiming a ticking area is only half the fix.
 *
 * With no players connected nothing is loaded or ticking, and touching any location throws
 * `LocationInUnloadedChunkError`. Claiming a ticking area is what fixes that — but the claim
 * does not take effect in the tick it is issued, and a battery that claims and then immediately
 * spawns is still asking about an unloaded chunk.
 *
 * That is exactly what happened on this battery's first real run against a Bedrock server:
 * three rows came back INCONCLUSIVE quoting `LocationInUnloadedChunkError`, which said nothing
 * whatsoever about Bedrock. The predecessor project hit the identical failure and recorded it
 * as "the exact failure this document exists to prevent: a confident-looking FAIL that was
 * measuring the instrument." Inheriting the lesson and not the fix is its own small lesson.
 *
 * So: claim, then WAIT for the chunk to actually answer, then measure.
 */
export const HEADLESS_AT = { x: 0.5, y: 8, z: 0.5 };

export function claimTickingArea(name: string): boolean {
  try {
    world
      .getDimension('overworld')
      .runCommand(`tickingarea add circle ${HEADLESS_AT.x} ${HEADLESS_AT.y} ${HEADLESS_AT.z} 2 ${name}`);
    return true;
  } catch {
    // Already claimed is the common case and is fine.
    return false;
  }
}

/** Can we touch the place the headless probes want to use? */
function chunkIsLive(): boolean {
  try {
    return world.getDimension('overworld').getBlock(HEADLESS_AT) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Run `then` once the headless location is usable, or after `tries` attempts either way.
 *
 * Running anyway on timeout is deliberate. The probes each report their own
 * `LocationInUnloadedChunkError` as INCONCLUSIVE, which is the honest verdict — the apparatus
 * failed, the game did not answer — and one loud NOTE above them says they share a cause.
 * Refusing to run at all would produce a battery with no output, which is worse: it looks the
 * same as a pack that never loaded.
 */
export function whenChunkIsLive(ctx: Ctx, then: () => void, tries = 40): void {
  if (chunkIsLive()) {
    then();
    return;
  }
  let n = 0;
  const handle = system.runInterval(() => {
    n++;
    if (chunkIsLive()) {
      system.clearRun(handle);
      then();
      return;
    }
    if (n < tries) return;
    system.clearRun(handle);
    console.warn(
      `${TAG} NOTE the ticking area never came up after ${tries} tries. Everything below that ` +
        `reports LocationInUnloadedChunkError is measuring the instrument, not the game.`,
    );
    ctx.say('§ethe ticking area never came up — INCONCLUSIVE rows below are the apparatus, not Bedrock§r');
    then();
  }, 5);
}
