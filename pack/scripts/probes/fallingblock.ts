/**
 * Can script see a vanilla falling block, and read it every tick while it falls?
 *
 * Any mechanic built around a falling vanilla block has to know this before it is designed: a
 * zero here forces a custom mover standing in for the real entity, which is a very different
 * and much larger piece of work than watching one.
 *
 * THE VELOCITIES ARE THE CONTROL. A sighting count alone would not tell you whether the entity
 * being watched is the real falling block or something that merely shares its type id, nor
 * whether `getVelocity()` on it returns anything meaningful — a collided entity's velocity
 * reads as zero, and a probe counting sightings would call that a pass. Vanilla falling-block
 * gravity is a known curve, so recording the samples lets the numbers confirm what the count
 * cannot.
 */

import { system, world } from '@minecraft/server';

import { PARAMS } from '../generated.ts';
import { firstLine, result, HEADLESS_AT, type Ctx } from '../emit.ts';

export function run(ctx: Ctx): void {
  const at = ctx.player?.location ?? HEADLESS_AT;
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');
  const origin = { x: Math.floor(at.x) + 0.5, y: at.y + PARAMS.falling_block.drop_height, z: Math.floor(at.z) + 0.5 };

  try {
    dimension.getBlock({ x: origin.x, y: origin.y, z: origin.z })?.setType(PARAMS.falling_block.block);
    // Breaking the block beneath is what makes it fall. Placing then clearing is more reliable
    // than trying to spawn a falling_block entity directly, which is not summonable.
    dimension.getBlock({ x: origin.x, y: origin.y - 1, z: origin.z })?.setType('minecraft:air');
  } catch (err) {
    result(ctx, 'entity.falling_block.is_trackable_by_script', 'INCONCLUSIVE', undefined,
      `could not place the block to drop: ${firstLine(err)}`);
    return;
  }

  const samples: { tick: number; y: number; vy: number }[] = [];
  let ticks = 0;

  const handle = system.runInterval(() => {
    ticks++;
    const found = dimension.getEntities({
      type: 'minecraft:falling_block',
      location: origin,
      maxDistance: PARAMS.falling_block.drop_height + 4,
    });
    for (const entity of found) {
      samples.push({
        tick: ticks,
        y: Number(entity.location.y.toFixed(3)),
        vy: Number(entity.getVelocity().y.toFixed(3)),
      });
    }

    if (ticks < PARAMS.falling_block.watch_ticks) return;
    system.clearRun(handle);

    const moving = samples.filter((s) => s.vy !== 0);
    result(
      ctx,
      'entity.falling_block.is_trackable_by_script',
      samples.length === 0 ? 'NO' : moving.length === 0 ? 'INCONCLUSIVE' : 'YES',
      { sightings: samples.length, samples: samples.slice(0, 12), watched_ticks: ticks },
      samples.length === 0
        ? 'the entity was never visible to getEntities while it fell'
        : moving.length === 0
          ? 'sighted, but every velocity read as zero — the sightings may be of a settled entity ' +
            'rather than a falling one, which is not what this asks'
          : `${samples.length} sightings with non-zero velocity — position and velocity are both readable in flight`,
    );
  }, 1);
}
