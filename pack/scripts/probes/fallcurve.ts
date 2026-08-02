/**
 * How fast does a vanilla falling block actually fall?
 *
 * A `solved` probe: the answer is a number, not a yes. It reports the greatest downward velocity
 * reached inside a fixed window, which is a single value the ledger can drift against, and
 * carries the whole sampled curve alongside it for anyone who needs the shape.
 *
 * TWO JOBS, AND THE SECOND IS WHY IT IS FIRST IN THE FILE.
 *
 * It answers a question worth answering: a mechanic that wants to predict where a falling block
 * will be, rather than watching it every tick, needs this curve.
 *
 * And it is the CONTROL for every other measured quantity here. If this number moves, the
 * engine's own integration changed, and no other physics reading can be compared across that
 * boundary — a throw distance measured before and after would differ for a reason that has
 * nothing to do with throwing. So this row is the one to read first when a sweep reports several
 * values moving at once: if it moved too, they probably all moved for the same reason.
 *
 * It is also what confirms the entity being watched is the real falling block rather than
 * something that shares its type id. Vanilla gravity is a known curve; a look-alike would not
 * follow it, and a collided entity reads as zero.
 */

import { system, world } from '@minecraft/server';

import { PARAMS } from '../generated.ts';
import { firstLine, result, willReportLater, HEADLESS_AT, type Ctx } from '../emit.ts';

const CAPABILITY = 'physics.falling_block.gravity_curve';

export function run(ctx: Ctx): void {
  const here = ctx.player?.location ?? HEADLESS_AT;
  // Its own ground. See the lanes note in `content/pack.yaml`.
  const at = { ...here, z: here.z + PARAMS.falling_block.lane };
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');
  const origin = {
    x: Math.floor(at.x) + 0.5,
    y: at.y + PARAMS.falling_block.drop_height,
    z: Math.floor(at.z) + 0.5,
  };

  try {
    dimension.getBlock({ x: origin.x, y: origin.y, z: origin.z })?.setType(PARAMS.falling_block.block);
    dimension.getBlock({ x: origin.x, y: origin.y - 1, z: origin.z })?.setType('minecraft:air');
  } catch (err) {
    result(ctx, CAPABILITY, 'INCONCLUSIVE', undefined, `could not place the block to drop: ${firstLine(err)}`);
    return;
  }

  const reported = willReportLater('fallcurve');
  const curve: { tick: number; vy: number }[] = [];
  let ticks = 0;

  const handle = system.runInterval(() => {
    ticks++;
    for (const entity of dimension.getEntities({
      type: 'minecraft:falling_block',
      location: origin,
      maxDistance: PARAMS.falling_block.drop_height + 4,
    })) {
      curve.push({ tick: ticks, vy: Number(entity.getVelocity().y.toFixed(4)) });
    }

    if (ticks < PARAMS.falling_block.watch_ticks) return;
    system.clearRun(handle);
    reported();

    // Downward velocity is negative, so the fastest is the MOST negative. Reported as a positive
    // magnitude because a scale with a sign on it reads badly and the direction is never in
    // doubt — a falling block does not fall up.
    const moving = curve.filter((s) => s.vy < 0);
    if (moving.length === 0) {
      result(
        ctx,
        CAPABILITY,
        'INCONCLUSIVE',
        { samples: curve.slice(0, 16), watched_ticks: ticks },
        curve.length === 0
          ? 'the falling block was never visible, so there is no curve to read'
          : 'sighted, but every velocity read as zero — a settled entity, not a falling one',
      );
      return;
    }

    const peak = Math.abs(Math.min(...moving.map((s) => s.vy)));
    result(
      ctx,
      CAPABILITY,
      'YES',
      { samples: curve.slice(0, 16), watched_ticks: ticks, sightings: curve.length },
      `peak downward velocity over ${ticks} ticks, from ${moving.length} moving sightings`,
      peak,
    );
  }, 1);
}
