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

import { world, type Player } from '@minecraft/server';

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
): void {
  count++;
  const payload = JSON.stringify({ ...(measurement ? { measurement } : {}), ...(evidence ? { evidence } : {}) });
  console.warn(`${TAG} RESULT ${capability} ${verdict} ${payload}`);
  const colour = verdict === 'YES' ? '§a' : verdict === 'NO' ? '§c' : '§e';
  ctx.player?.sendMessage(`§b[${TAG}]§r ${colour}${verdict}§r §7${capability}§r ${evidence ?? ''}`);
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
  console.warn(`${TAG} BEGIN ${new Date().toISOString()}`);
}

export function done(ctx: Ctx): void {
  ctx.say(`§l---§r battery complete: ${count} line(s). Eyes-only rows are recorded by \`bedshock amend\`.`);
  console.warn(`${TAG} DONE ${count}`);
}

/**
 * Where a headless run puts things, and why it has to claim a ticking area first.
 *
 * With no players connected, nothing is loaded or ticking and spawning anywhere throws
 * `LocationInUnloadedChunkError`. The first CI run of a battery like this duly reported that
 * as two container failures, which said nothing whatsoever about Bedrock — a confident-looking
 * FAIL that was measuring the instrument. Claiming the area is the fix, and it is done once,
 * here, rather than remembered by each probe.
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
