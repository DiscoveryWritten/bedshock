/**
 * A box to measure in, and a check that the box is actually there.
 *
 * THE PROBLEM THIS SOLVES is not "carving a room is tedious". It is that a probe measuring
 * movement in a place it did not verify is measuring the terrain. A thrown item that stops after
 * two blocks stopped because it hit a wall; a knocked-back entity that does not move is standing
 * in a hole. Both produce a number, both look like physics, and neither is.
 *
 * So `verify()` is not a convenience — it is the reason this file exists. Carve the box, check
 * the box, and if it is not there, say so instead of measuring. A probe that reports
 * `the arena is not clear` has told you something true; one that reports `2.1 blocks` from the
 * same situation has not.
 *
 * WHY IT IS IN THE HARNESS rather than kept private. This is the smallest useful thing a project
 * vendoring bedshock needs and the most annoying to write: somewhere flat, empty, known, and
 * confirmed, to put a mechanic in and watch what it does. Wanting to answer "how much boost does
 * my portal need to clear the floor on exit" should not begin with three hours of arranging
 * blocks — the whole point of a shared apparatus is that the setup is the shared part.
 *
 * IT IS DELIBERATELY CRUDE. Axis-aligned, `+x` is forward, one dimension, no rotation, no
 * decoration. A box you can reason about beats a room you have to model, and every feature added
 * here is another thing a measurement could be blaming instead of the game.
 */

import { world, type Dimension, type Vector3 } from '@minecraft/server';

export interface ArenaSpec {
  /** Blocks of clear run along `+x` from the origin. */
  length: number;
  /** Blocks of headroom above the floor. */
  height: number;
  /** Blocks of clearance either side of the centre line. 0 is a one-wide corridor. */
  width?: number;
  /** What the floor is made of. Must be solid, or nothing rests on it. */
  floor?: string;
  /** How far behind the origin to clear, so a knockback that goes backwards is still measurable. */
  behind?: number;
}

export interface Arena {
  /** The standing point: the centre of the floor's top face, at `x + 0.5`. */
  readonly origin: Vector3;
  /** A point in arena coordinates. `forward` along `+x`, `up` from the floor's top face. */
  at(forward: number, up?: number, side?: number): Vector3;
  /** How far along the arena a world position is, in blocks. Negative is behind the origin. */
  forwardOf(position: Vector3): number;
  /** Horizontal distance from the origin, ignoring height. */
  distanceFrom(position: Vector3): number;
  /** Carve it. Safe to call every reading, and you should. */
  clear(): void;
  /** Remove every entity of a type inside it, so one reading cannot inherit the last one's. */
  sweep(...types: string[]): void;
  /**
   * Is the box really there? Returns a problem to report, or nothing.
   *
   * Pass this straight to `record(null, problem)` — an unverified arena is an apparatus failure,
   * never a reading of zero.
   */
  verify(): string | undefined;
}

const DEFAULT_FLOOR = 'minecraft:stone';

export function arena(at: Vector3, spec: ArenaSpec, dimension?: Dimension): Arena {
  const dim = dimension ?? world.getDimension('overworld');
  const floorType = spec.floor ?? DEFAULT_FLOOR;
  const width = spec.width ?? 0;
  const behind = spec.behind ?? 0;

  // The floor block sits one below the standing height, so `up: 0` is the surface you stand on.
  const baseX = Math.floor(at.x);
  const baseY = Math.floor(at.y);
  const baseZ = Math.floor(at.z);

  const point = (forward: number, up = 0, side = 0): Vector3 => ({
    x: baseX + forward + 0.5,
    y: baseY + up,
    z: baseZ + side + 0.5,
  });

  /** Every block position in the box, floor included, as [x, y, z] offsets. */
  const cells = function* (): Generator<{ f: number; u: number; s: number }> {
    for (let f = -behind; f <= spec.length; f++) {
      for (let s = -width; s <= width; s++) {
        for (let u = -1; u < spec.height; u++) yield { f, u, s };
      }
    }
  };

  const block = (f: number, u: number, s: number) =>
    dim.getBlock({ x: baseX + f, y: baseY + u, z: baseZ + s });

  return {
    origin: point(0),

    at: point,

    forwardOf(position: Vector3): number {
      return position.x - (baseX + 0.5);
    },

    distanceFrom(position: Vector3): number {
      const dx = position.x - (baseX + 0.5);
      const dz = position.z - (baseZ + 0.5);
      return Math.sqrt(dx * dx + dz * dz);
    },

    clear(): void {
      for (const { f, u, s } of cells()) {
        // The floor is laid, not merely cleared. Whatever the terrain happens to be at these
        // coordinates -- stone, a cave, open air over an ocean -- the arena is the same box.
        block(f, u, s)?.setType(u === -1 ? floorType : 'minecraft:air');
      }
    },

    sweep(...types: string[]): void {
      const centre = point(Math.floor(spec.length / 2), 1);
      const reach = spec.length + behind + width + spec.height + 4;
      for (const type of types) {
        for (const entity of dim.getEntities({ type, location: centre, maxDistance: reach })) {
          try {
            entity.remove();
          } catch {
            // Already gone between the query and the removal. Nothing to do, and nothing wrong.
          }
        }
      }
    },

    verify(): string | undefined {
      // Sampled rather than exhaustive: the ends and the middle catch a chunk that never loaded
      // and a floor that never went down, which are the two failures worth distinguishing from a
      // measurement. Checking every cell would double the cost of every reading to catch a case
      // -- a single stray block mid-arena -- that `clear()` just wrote over.
      for (const f of [-behind, 0, Math.floor(spec.length / 2), spec.length]) {
        const under = block(f, -1, 0);
        if (!under) return `the arena is not loaded at ${f} blocks along — the chunk is not there`;
        if (under.typeId !== floorType) return `the arena has no floor at ${f} blocks along (found "${under.typeId}")`;
        for (const u of [0, spec.height - 1]) {
          const air = block(f, u, 0);
          if (!air) return `the arena is not loaded at ${f} blocks along, ${u} up`;
          if (!air.isAir) return `the arena is blocked at ${f} blocks along, ${u} up (found "${air.typeId}")`;
        }
      }
      return undefined;
    },
  };
}
