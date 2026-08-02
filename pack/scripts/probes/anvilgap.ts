/**
 * How late can something get out from under a falling anvil?
 *
 * A `solved` probe, and the first one built on `solve.ts`. There is no yes here: there is a
 * clearance, and the clearance is the answer.
 *
 * THE APPARATUS. A stone block sits on a plane with an anvil falling towards it. At the tick
 * where the anvil is within the requested clearance of the block's top face, the block is
 * REMOVED. Either it left in time and the anvil falls past, or it did not and the anvil lands
 * on it. The search is for the smallest clearance where leaving still works.
 *
 * WHY THE BLOCK LEAVES RATHER THAN ARRIVES, because the obvious build is the other way round
 * and it cannot be run at all. Making a block APPEAR at a chosen clearance requires a tick at
 * which the anvil is at that clearance, and the anvil only exists at tick-spaced positions —
 * below one tick of travel there is no such moment. Every trial finer than that has to abort,
 * including the tight bound, and a search whose tight bound cannot be evaluated has nothing to
 * bisect between.
 *
 * Removing a block that was already there turns that same limit into the right answer. Ask for a
 * clearance too fine to hit and the anvil lands before the block is taken away — CAUGHT, which is
 * precisely what a clearance that tight means. The tick lattice becomes the resolution instead of
 * an abort, which is why the tolerance on this row is one tick of travel and says so.
 *
 * WHAT IT IS KIN TO. This is the tunnelling threshold wearing different clothes. A mover fast
 * enough to cross a block between two ticks is never observed inside it, and anything that
 * watches for an intersection rather than integrating a path will miss it. That is the same
 * failure a portal has when something enters too fast to be seen entering — so if this number
 * moves, treat every threshold built on "it will be there when I look" as suspect.
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
  const at = ctx.player?.location ?? HEADLESS_AT;
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
    let removed = false;
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
      if (!removed && y !== undefined && y - planeTop <= clearance) {
        try {
          dimension.getBlock(columnAt(planeY))?.setType('minecraft:air');
        } catch (err) {
          finish(null, `could not remove the obstruction: ${firstLine(err)}`);
          return;
        }
        removed = true;
      }

      // Below the plane and still an entity: it went past. That is the property holding.
      if (y !== undefined && y < planeTop - 0.5) {
        finish(true, `passed the plane with the obstruction removed at ${round(clearance)} blocks`);
        return;
      }

      // No entity left, and something is sitting on the plane: it landed. Checked only once the
      // anvil has stopped being an entity, so an anvil still in flight is never read as landed.
      if (y === undefined && sighted) {
        const landed = dimension.getBlock(columnAt(planeTop))?.typeId;
        finish(
          false,
          landed === p.block
            ? `landed on the plane at ${round(clearance)} blocks of clearance`
            : `stopped being a falling block above the plane (found "${landed ?? 'nothing'}" there)`,
        );
        return;
      }

      if (ticks < p.watch_ticks) return;
      finish(
        null,
        sighted
          ? `neither landed nor passed within ${ticks} ticks; lowest sighting was ${round(lowest - planeTop)} above the plane`
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
