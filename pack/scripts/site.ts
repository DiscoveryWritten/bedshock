/**
 * The plot everything is built on, and the machinery that builds one step at a time.
 *
 * A FIXED PLACE, NOT A PLACE NEAR YOU. The site is at the same absolute coordinates in every
 * world, every run — so "go and look at what it built" is a teleport rather than a search, and a
 * screenshot from one session lines up with a screenshot from another. `arena.ts` builds relative
 * to the player because a probe needs ground under whoever is running it; a facility needs to be
 * findable.
 *
 * HIGH UP, BECAUSE THERE IS NOTHING THERE. At two hundred blocks the world is air: no terrain to
 * excavate, no caves to fall into, no water, no trees, nothing that was already there to be
 * confused with something we placed. Demolition is just as easy, because the correct "nothing" at
 * that height is air rather than whatever stone used to be underneath. Paving at ground level
 * would mean deleting a landscape and then never being sure the landscape was fully gone.
 *
 * BUILT FRESH EVERY RUN, AND THAT IS THE POINT. A facility shipped pre-built in the world is a
 * facility whose construction is never exercised — assembled once on an afternoon when things
 * worked, inherited blindly ever after, and capable of quietly benefiting from a bug that existed
 * at bake time. Building it floor-up puts the construction under test with everything else.
 *
 * AND IT STOPS WHERE IT BROKE. Each step is verified before the next one runs, so a failure
 * leaves a half-built facility whose last complete course is the diagnosis. That is deliberate:
 * a build that tore itself down on failure would take the evidence with it.
 */

import { system, world, type Dimension, type Vector3 } from '@minecraft/server';

import { footprint, type Blueprint, type Cell, type Placement } from './blueprint.ts';
import { firstLine } from './emit.ts';

/**
 * Where the facility lives. Chunk-aligned at the origin, high in the air.
 *
 * Changing this invalidates every screenshot and every "go and look at" instruction ever written
 * down, so it is a constant rather than a parameter.
 */
export const SITE = { x: 0.5, y: 200, z: 0.5 };

/** How much air to clear around the footprint before building into it. */
const MARGIN = 2;

export interface BuildResult {
  built: boolean;
  /** Steps completed, in order. */
  done: string[];
  /** The step that failed, if one did. */
  failed?: string;
  why?: string;
}

export interface Site {
  readonly origin: Vector3;
  /** A blueprint cell in world coordinates. */
  at(cell: Cell): Vector3;
  /** Air out the whole footprint, plus a margin, so nothing left over can be mistaken for ours. */
  clear(blueprint: Blueprint): void;
  /** Build one step. Returns a problem, or nothing. */
  step(placements: readonly Placement[], verify: readonly Cell[]): string | undefined;
  /** Build the whole thing in order, stopping at the first step that does not verify. */
  build(blueprint: Blueprint): BuildResult;
  /** Take it all down, so the next chapter starts from air. */
  demolish(blueprint: Blueprint): void;
  /** Stand somebody in front of it, looking at it. */
  bring(at: Cell, lookAt?: Cell): void;
}

export function site(dimension?: Dimension, origin: Vector3 = SITE): Site {
  const dim = dimension ?? world.getDimension('overworld');
  const baseX = Math.floor(origin.x);
  const baseY = Math.floor(origin.y);
  const baseZ = Math.floor(origin.z);

  const place = (cell: Cell): Vector3 => ({ x: baseX + cell.f, y: baseY + cell.u, z: baseZ + cell.s });

  const air = (span: { from: Cell; to: Cell }): void => {
    for (let f = span.from.f - MARGIN; f <= span.to.f + MARGIN; f++) {
      for (let u = span.from.u - MARGIN; u <= span.to.u + MARGIN; u++) {
        for (let s = span.from.s - MARGIN; s <= span.to.s + MARGIN; s++) {
          dim.getBlock(place({ f, u, s }))?.setType('minecraft:air');
        }
      }
    }
  };

  const self: Site = {
    origin: place({ f: 0, u: 0, s: 0 }),

    at: place,

    clear(blueprint: Blueprint): void {
      air(footprint(blueprint));
    },

    step(placements, verify): string | undefined {
      try {
        for (const p of placements) dim.getBlock(place(p))?.setType(p.block);
      } catch (err) {
        return `could not place: ${firstLine(err)}`;
      }
      // Verified immediately rather than at the end, so a failure names the course it happened
      // on instead of the finished building.
      const wanted = new Map(placements.map((p) => [`${p.f},${p.u},${p.s}`, p.block]));
      for (const cell of verify) {
        const expected = wanted.get(`${cell.f},${cell.u},${cell.s}`);
        if (expected === undefined) continue;
        let found: string | undefined;
        try {
          found = dim.getBlock(place(cell))?.typeId;
        } catch (err) {
          return `could not read back ${cell.f},${cell.u},${cell.s}: ${firstLine(err)}`;
        }
        if (found !== expected) {
          return `expected ${expected} at ${cell.f},${cell.u},${cell.s} and found ${found ?? 'nothing loaded'}`;
        }
      }
      return undefined;
    },

    build(blueprint: Blueprint): BuildResult {
      self.clear(blueprint);
      const done: string[] = [];
      for (const step of blueprint.steps) {
        const problem = self.step(step.places, step.verify ?? step.places);
        if (problem) {
          // DELIBERATELY NOT TORN DOWN. The half-built facility is the evidence, and its last
          // complete course is where to go and look.
          return { built: false, done, failed: step.name, why: problem };
        }
        done.push(step.name);
      }
      return { built: true, done };
    },

    demolish(blueprint: Blueprint): void {
      air(footprint(blueprint));
    },

    bring(at: Cell, lookAt?: Cell): void {
      for (const player of world.getAllPlayers()) {
        try {
          const standing = place(at);
          player.teleport(standing, lookAt ? { facingLocation: place(lookAt) } : {});
        } catch {
          // Somebody left, or the chunk is not there yet. The build itself reports that.
        }
      }
    },
  };

  return self;
}

/**
 * Make the site's chunks real, then carry on.
 *
 * The same lesson as `whenChunkIsLive` and for the same reason: a ticking area does not take
 * effect in the tick it is claimed, and building into an unloaded chunk throws in a way that says
 * nothing about anything. Two hundred blocks above spawn is nowhere a player has been, so this
 * matters more here than anywhere else in the battery.
 */
export function whenSiteIsLive(then: (ok: boolean) => void, origin: Vector3 = SITE, tries = 60): void {
  const dim = world.getDimension('overworld');
  try {
    dim.runCommand(`tickingarea add circle ${origin.x} ${origin.y} ${origin.z} 4 bedshock_site`);
  } catch {
    // Already claimed is the usual case and is fine.
  }

  const live = (): boolean => {
    try {
      return dim.getBlock(origin) !== undefined;
    } catch {
      return false;
    }
  };

  if (live()) {
    then(true);
    return;
  }
  let n = 0;
  const handle = system.runInterval(() => {
    n++;
    if (live()) {
      system.clearRun(handle);
      then(true);
      return;
    }
    if (n < tries) return;
    system.clearRun(handle);
    then(false);
  }, 5);
}
