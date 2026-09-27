/**
 * The thin start: a player spawning is all it takes. A moment later the presence rows run and
 * report, then a quiet heartbeat keeps the log current -- where the player is, what they hold and
 * look at, how they are playing -- so a harness reading the log never has to ask.
 *
 * Not a probe: it measures nothing itself. It runs `probes/presence.ts` and reuses its snapshot.
 */

import { system, world } from '@minecraft/server';

import { begin, done, firstLine, makeCtx } from './emit.ts';
import { run, snapshot } from './probes/presence.ts';


const HEARTBEAT_TICKS = 100;
/** Say something even when nothing changed, so silence always means the pipe is gone. */
const ALIVE_EVERY = 12;

let last = '';
let quiet = 0;

function heartbeat(): void {
  const p = world.getPlayers()[0];
  if (!p) return;
  const snap = snapshot(p);
  // Compare what changed, not the numbers' last digits: a player standing still should not spam.
  const key = JSON.stringify({ ...snap, at: { x: Math.round(snap.at.x), y: Math.round(snap.at.y), z: Math.round(snap.at.z) }, view: null });
  if (key === last && ++quiet < ALIVE_EVERY) return;
  last = key;
  quiet = 0;
  console.warn(`BEDSHOCK NOTE presence ${JSON.stringify(snap)}`);
}

export function install(): void {
  let ran = false;
  world.afterEvents.playerSpawn.subscribe((e) => {
    if (!e.initialSpawn || ran) return;
    ran = true;
    // A moment to let the client finish arriving, then the rows, then the heartbeat.
    system.runTimeout(() => {
      const ctx = makeCtx(e.player);
      begin();
      try {
        run(ctx);
      } catch (err) {
        console.warn(`BEDSHOCK ERROR presence ${firstLine(err)}`);
      }
      done(ctx);
      system.runInterval(() => {
        try {
          heartbeat();
        } catch {
          // A heartbeat that throws once should not stop; the next one says whether it recovered.
        }
      }, HEARTBEAT_TICKS);
    }, 40);
  });
}
