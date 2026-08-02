/**
 * How far does a thrown item actually go?
 *
 * A `solved` row of the MEASURING kind rather than the searching kind. There is no boundary here
 * to bracket — the item lands somewhere and the somewhere is the answer — so this uses
 * `measure()` and not `solve()`.
 *
 * THE NUMBER IS RELATIVE TO AN IMPULSE, and that is the thing to understand before reading it.
 * "How far does a thrown item travel" has no answer until you say how hard it was thrown. A
 * player's throw is not scriptable, so the probe applies a declared impulse from
 * `content/pack.yaml` and reports the distance that impulse buys. Change the impulse and the
 * number changes for a reason that has nothing to do with Bedrock, which is why it lives in a
 * file with the rest of the apparatus and is stated in the row's notes.
 *
 * WHY IT IS WORTH RECORDING ANYWAY, given the impulse is ours. Nothing here is testing throwing.
 * It is testing the drag, the friction and the integration that a thrown item is subject to --
 * and anything a project builds that launches something inherits all three. A design tuned to
 * "an item given this much shove lands about there" fails when that changes, and it fails
 * looking like a bug in the design rather than a change in the game.
 *
 * THE ARENA IS THE MEASUREMENT. An item that stops after two blocks stopped because it hit a
 * wall, and that reading is indistinguishable from physics. So the box is carved AND verified
 * before every reading, and a box that is not there is an apparatus failure rather than a short
 * throw.
 */

import { ItemStack, system, world, type Entity } from '@minecraft/server';

import { PARAMS } from '../generated.ts';
import { SOLVES } from '../catalog.generated.ts';
import { arena } from '../arena.ts';
import { firstLine, HEADLESS_AT, skipped, type Ctx } from '../emit.ts';
import { measure, type Record } from '../measure.ts';

const CAPABILITY = 'physics.throw.item_travel_distance';

export function run(ctx: Ctx): void {
  const spec = SOLVES.find((s) => s.id === CAPABILITY);
  if (!spec) {
    skipped(ctx, CAPABILITY, 'the catalog no longer declares this as a solved row');
    return;
  }

  const p = PARAMS.throw;
  const at = ctx.player?.location ?? HEADLESS_AT;
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');
  const box = arena(at, { length: p.run_length, height: p.headroom, width: 1 }, dimension);

  const reading = (_index: number, record: Record): void => {
    let item: Entity;
    try {
      box.sweep('minecraft:item');
      box.clear();
      const problem = box.verify();
      if (problem) {
        record(null, problem);
        return;
      }
      item = dimension.spawnItem(new ItemStack(p.item, 1), box.at(0, p.release_height));
      // Spawned items carry a small random scatter so a dropped stack does not pile up. Zeroing
      // it is what makes two readings comparable; without it the throw is our impulse plus an
      // unknown, and the scatter would land in the spread rather than in the number.
      item.clearVelocity();
      item.applyImpulse({ x: p.impulse_forward, y: p.impulse_up, z: 0 });
    } catch (err) {
      record(null, `could not launch the item: ${firstLine(err)}`);
      return;
    }

    let ticks = 0;
    let still = 0;
    let furthest = 0;

    const handle = system.runInterval(() => {
      ticks++;

      if (!item.isValid) {
        system.clearRun(handle);
        // Despawned, merged with another stack, or fell out of the world. Any of those is the
        // apparatus losing the subject, and none of them is a distance.
        record(null, `the item stopped existing after ${ticks} tick(s), ${round(furthest)} blocks along`);
        return;
      }

      let velocity;
      let here;
      try {
        velocity = item.getVelocity();
        here = item.location;
      } catch (err) {
        system.clearRun(handle);
        record(null, `lost the item mid-flight: ${firstLine(err)}`);
        return;
      }

      furthest = Math.max(furthest, box.distanceFrom(here));

      // AN ITEM THAT NEVER MOVED IS NOT A THROW OF ZERO. Zero is inside the plausible range, so
      // an item stuck against a wall -- or one whose impulse never took -- would be recorded five
      // times over as a confident distance of nothing, with perfect agreement between the
      // readings to make it look solid. The rest test cannot fire until it has actually gone
      // somewhere, which is the same correction the knockback probe needed.
      if (furthest < p.moved_at_least) {
        if (ticks < p.watch_ticks) return;
        system.clearRun(handle);
        box.sweep('minecraft:item');
        record(null, `the item never left the origin over ${ticks} tick(s) — the impulse did nothing`);
        return;
      }

      const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
      still = speed < p.rest_speed ? still + 1 : 0;

      if (still >= p.rest_ticks) {
        system.clearRun(handle);
        const distance = box.distanceFrom(here);
        box.sweep('minecraft:item');
        record(distance, `came to rest after ${ticks} tick(s)`);
        return;
      }

      if (ticks < p.watch_ticks) return;
      system.clearRun(handle);
      box.sweep('minecraft:item');
      // Still moving when the window closed. Reporting where it happened to be would be a
      // measurement of the watch window rather than of the throw.
      record(null, `still moving after ${ticks} tick(s), ${round(furthest)} blocks along`);
    }, 1);
  };

  measure(
    ctx,
    {
      capability: CAPABILITY,
      probe: 'throw',
      unit: spec.unit,
      samples: p.samples,
      spread: p.spread,
      range: { from: spec.from, to: spec.to },
      cooldown: 8,
      readingTimeout: p.watch_ticks + 40,
    },
    reading,
  );
}

const round = (n: number): number => Number(n.toFixed(3));
