/**
 * How early can something start getting out from under a falling anvil, and still be clear?
 *
 * A `solved` probe, and the first one built on `solve.ts`. There is no yes here: there is a
 * clearance, and the clearance is the answer.
 *
 * THE APPARATUS. A stone block sits on a plane with an anvil falling towards it. At the tick
 * where the anvil is within the requested clearance of the block's top face, the block is
 * REMOVED — and then PUT BACK a fixed number of ticks later. Either the plane was still empty
 * when the anvil arrived and it fell past, or the block was back in time and the anvil landed on
 * it. The search is for the largest clearance at which leaving that early still works.
 *
 * WHY THE BLOCK GOES AND RETURNS, and this took three shapes with a real server correcting the
 * third-to-last:
 *
 *   Making a block APPEAR at a chosen clearance cannot be run at all. It needs a tick at which
 *   the anvil is at that clearance, and the anvil only exists at tick-spaced positions — below
 *   one tick of travel there is no such moment. Every fine trial aborts, INCLUDING the tight
 *   bound, and a search whose tight bound cannot be evaluated has nothing to bisect between.
 *
 *   Merely REMOVING a block runs, and measures nothing. Bedrock 1.26.36.1 said `held even at 0,
 *   the tight end of the search`: the anvil got through even when the block left at the instant
 *   of contact. Of course it did — removal keyed to the anvil's own arrival is never late. The
 *   trial was reporting its trigger condition, and would have reported the same number on every
 *   version of the game. Nothing about reading the code showed that; it took a run.
 *
 *   Removing it and putting it BACK makes the clearance mean something. It now sets how EARLY
 *   the mover leaves, and the anvil decides whether that was too early. Leave late and it slips
 *   through; leave early and the stone is home before it arrives. That is a pass-under's real
 *   timing budget, and it is the number a mechanic actually has to respect.
 *
 * WHAT IT IS KIN TO. This is a tunnelling threshold wearing different clothes. What it really
 * measures is how far the anvil travels while the plane is empty — so anything that watches for
 * an intersection rather than integrating a path inherits it. That is the same failure a portal
 * has when something enters too fast to be seen entering, so if this number moves, treat every
 * threshold built on "it will be there when I look" as suspect.
 */

import { system, world, type Vector3 } from '@minecraft/server';

import { PARAMS } from '../generated.ts';
import { SOLVES } from '../catalog.generated.ts';
import { firstLine, HEADLESS_AT, skipped, type Ctx } from '../emit.ts';
import { solve, type Settle } from '../solve.ts';

const CAPABILITY = 'physics.falling_block.min_clearance_under_a_falling_anvil';

export function run(ctx: Ctx): void {
  const spec = SOLVES.find((s) => s.id === CAPABILITY);
  if (!spec) {
    // The catalog stopped declaring the row this probe answers. Saying so beats searching for a
    // boundary nothing would record.
    skipped(ctx, CAPABILITY, 'the catalog no longer declares this as a solved row');
    return;
  }

  const p = PARAMS.anvilgap;
  const here = ctx.player?.location ?? HEADLESS_AT;
  // Its own ground. See the lanes note in `content/pack.yaml`.
  const at = { ...here, z: here.z + PARAMS.anvilgap.lane };
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');

  const x = Math.floor(at.x) + 0.5;
  const z = Math.floor(at.z) + 0.5;
  const floor = Math.floor(at.y);
  /** The block the obstruction occupies. */
  const planeY = floor + p.plane_height;
  /** Its top face — clearances are measured from here. */
  const planeTop = planeY + 1;
  const sourceY = planeTop + p.drop_height;

  const columnAt = (y: number): Vector3 => ({ x, y, z });

  /** Air from below the plane to above the source, and no leftovers from the last trial. */
  const clearColumn = (): void => {
    for (let y = floor - 2; y <= sourceY + 1; y++) {
      dimension.getBlock(columnAt(y))?.setType('minecraft:air');
    }
    for (const entity of dimension.getEntities({
      type: 'minecraft:falling_block',
      location: columnAt(planeTop),
      maxDistance: p.drop_height + p.plane_height + 8,
    })) {
      entity.remove();
    }
  };

  /** The lowest falling block anywhere near the column, or nothing. */
  const anvil = (): number | undefined => {
    const seen = dimension.getEntities({
      type: 'minecraft:falling_block',
      location: columnAt(planeTop),
      maxDistance: p.drop_height + p.plane_height + 8,
    });
    if (seen.length === 0) return undefined;
    return Math.min(...seen.map((e) => e.location.y));
  };

  const trial = (clearance: number, settle: Settle): void => {
    try {
      clearColumn();
      dimension.getBlock(columnAt(planeY))?.setType(p.obstruction);
      dimension.getBlock(columnAt(sourceY))?.setType(p.block);
    } catch (err) {
      settle(null, `could not set up the column: ${firstLine(err)}`);
      return;
    }

    let ticks = 0;
    /** The tick the stone left, or nothing while it is still there. */
    let leftAt: number | undefined;
    let restored = false;
    let sighted = false;
    let lowest = sourceY;

    const finish = (held: boolean | null, note?: string): void => {
      system.clearRun(handle);
      try {
        clearColumn();
      } catch {
        // A failed cleanup is the NEXT trial's problem, and it starts by clearing the column
        // again. Losing this trial's answer over it would be the worse trade.
      }
      settle(held, note);
    };

    const handle = system.runInterval(() => {
      ticks++;
      let y: number | undefined;
      try {
        y = anvil();
      } catch (err) {
        finish(null, `lost the column mid-trial: ${firstLine(err)}`);
        return;
      }

      if (y !== undefined) {
        sighted = true;
        lowest = Math.min(lowest, y);
      }

      // The one moment that defines the trial: the block leaves.
      if (leftAt === undefined && y !== undefined && y - planeTop <= clearance) {
        try {
          dimension.getBlock(columnAt(planeY))?.setType('minecraft:air');
        } catch (err) {
          finish(null, `could not remove the obstruction: ${firstLine(err)}`);
          return;
        }
        leftAt = ticks;
      }

      // Below the plane and still an entity: it went past. That is the property holding.
      //
      // Checked BEFORE the block is put back, which is what stops a caught anvil from being read
      // as a passing one. A landed anvil is a block resting on the plane, and restoring the stone
      // under a block that is already there does not move it — but an anvil is gravity-affected,
      // so had the stone stayed away it would simply have fallen again and been sighted below.
      if (y !== undefined && y < planeTop - 0.5) {
        finish(
          true,
          `passed: the plane was still empty when it arrived, having left at ${round(clearance)} blocks`,
        );
        return;
      }

      // And the block comes home. Everything the clearance means lives in this window.
      if (leftAt !== undefined && !restored && ticks - leftAt >= p.vacate_ticks) {
        try {
          dimension.getBlock(columnAt(planeY))?.setType(p.obstruction);
        } catch (err) {
          finish(null, `could not put the obstruction back: ${firstLine(err)}`);
          return;
        }
        restored = true;
      }

      // No entity left, and something is sitting on the plane: it landed. Checked only once the
      // anvil has stopped being an entity, so an anvil still in flight is never read as landed.
      if (y === undefined && sighted) {
        const landed = dimension.getBlock(columnAt(planeTop))?.typeId;
        finish(
          false,
          landed === p.block
            ? `caught: the stone was back before it arrived, having left at ${round(clearance)} blocks`
            : `stopped being a falling block above the plane (found "${landed ?? 'nothing'}" there)`,
        );
        return;
      }

      if (ticks < p.watch_ticks) return;
      finish(
        null,
        sighted
          ? `neither landed nor passed within ${ticks} ticks; lowest sighting was ` +
              `${round(lowest - planeTop)} above the plane, stone ${leftAt === undefined ? 'never left' : restored ? 'left and returned' : 'still away'}`
          : `the source block never became a falling ${p.block}`,
      );
    }, 1);
  };

  solve(
    ctx,
    {
      capability: CAPABILITY,
      probe: 'anvilgap',
      unit: spec.unit,
      direction: spec.direction,
      from: spec.from,
      to: spec.to,
      tolerance: spec.tolerance,
      repeats: p.repeats,
      maxTrials: p.max_trials,
      // Long enough for the column to settle and any stray entity to be gone. A trial that
      // starts while the previous anvil is still falling measures two anvils.
      cooldown: 6,
      trialTimeout: p.watch_ticks + 40,
    },
    trial,
  );
}

const round = (n: number): number => Number(n.toFixed(3));
