/**
 * What gets built, in what order, and what that order is allowed to do.
 *
 * THIS FILE IMPORTS NOTHING, like `bisect.ts` and `sample.ts` before it. A blueprint is a list of
 * places and blocks — data — and the properties worth guarding about it are arithmetic. Keeping
 * it free of `@minecraft/server` is what lets a build order be checked before anybody imports
 * anything, on a machine with no game on it.
 *
 * WHY BUILD AT ALL, RATHER THAN SHIPPING A WORLD WITH THE FACILITY IN IT. Because a facility that
 * arrives pre-built is a facility whose construction is never tested. It was assembled once, on
 * some afternoon when things happened to work, and every run afterwards inherits that afternoon.
 * If the game changes such that a piece of it can no longer be built, a baked-in world keeps
 * working and says nothing — and worse, a measurement might quietly benefit from a bug that was
 * present at bake time and is gone now, or vice versa. Building floor-up on every run puts the
 * construction under test alongside everything else, which is the only way the apparatus and the
 * game stay honest with each other.
 *
 * A STEP IS NAMED AND VERIFIED, and that is the whole reason this is a sequence rather than a
 * blob of `setType` calls. When a build fails you get "step 3 of 7, `the drop column`, expected
 * anvil at 0,16,0 and found air" — a place to go and look — instead of a facility that is subtly
 * wrong in a way nobody notices until a number comes out strange.
 *
 * THE ONE PROPERTY A BUILD ORDER MUST HAVE is that later steps do not silently undo earlier ones.
 * `overwrites()` finds every cell written twice, and the pack tests refuse a blueprint that has
 * any it did not declare. That is the same failure the probe lanes had — two things writing the
 * same space and the result looking like physics — caught here at the level of data, before
 * anything is placed.
 */

/** A position in blueprint space: forward along `+x`, up from the floor, sideways along `+z`. */
export interface Cell {
  f: number;
  u: number;
  s: number;
}

export interface Placement extends Cell {
  block: string;
}

export interface Step {
  /** Short, and it will be read aloud when a build fails here. `the floor`, `the drop column`. */
  name: string;
  places: Placement[];
  /**
   * Cells to check after this step, before the next one runs. Defaults to everything it placed.
   *
   * Narrow it when a step deliberately places something the game will change — a gravity block
   * that is meant to fall, a fluid that is meant to flow — because verifying those would fail on
   * a facility that built perfectly.
   */
  verify?: Cell[];
  /**
   * Cells this step is ALLOWED to overwrite, named rather than assumed.
   *
   * Clearing before building is legitimate; quietly writing over the thing you built two steps
   * ago is not. Declaring it is the difference.
   */
  mayOverwrite?: Cell[];
}

export interface Blueprint {
  name: string;
  steps: Step[];
}

const key = (c: Cell): string => `${c.f},${c.u},${c.s}`;

/** Every cell a blueprint touches, in build order, with duplicates kept. */
export function cells(blueprint: Blueprint): Placement[] {
  return blueprint.steps.flatMap((s) => s.places);
}

export interface Footprint {
  from: Cell;
  to: Cell;
  /** Distinct cells, which is what the site has to clear. */
  size: number;
}

export function footprint(blueprint: Blueprint): Footprint {
  const all = cells(blueprint);
  if (all.length === 0) {
    return { from: { f: 0, u: 0, s: 0 }, to: { f: 0, u: 0, s: 0 }, size: 0 };
  }
  const axis = (pick: (c: Cell) => number) => all.map(pick);
  return {
    from: { f: Math.min(...axis((c) => c.f)), u: Math.min(...axis((c) => c.u)), s: Math.min(...axis((c) => c.s)) },
    to: { f: Math.max(...axis((c) => c.f)), u: Math.max(...axis((c) => c.u)), s: Math.max(...axis((c) => c.s)) },
    size: new Set(all.map(key)).size,
  };
}

export interface Overwrite {
  cell: Cell;
  /** Step names, in order, that wrote this cell. */
  by: string[];
  blocks: string[];
}

/**
 * Every cell written by more than one step, minus the ones a step said it would.
 *
 * A LATER STEP SILENTLY REPLACING AN EARLIER ONE IS A BUILD-ORDER BUG, and it is invisible in
 * play: the facility looks finished, the wrong block is where the right one should be, and the
 * measurement taken against it comes out plausible. This is the same shape as two probes sweeping
 * each other's arenas — which cost three readings in five and read exactly like a despawn — found
 * here in data rather than there in physics.
 */
export function overwrites(blueprint: Blueprint): Overwrite[] {
  const seen = new Map<string, { by: string[]; blocks: string[]; cell: Cell }>();
  const allowed = new Set<string>();
  const out: Overwrite[] = [];

  for (const step of blueprint.steps) {
    for (const cell of step.mayOverwrite ?? []) allowed.add(key(cell));
    for (const place of step.places) {
      const k = key(place);
      const before = seen.get(k);
      if (before) {
        before.by.push(step.name);
        before.blocks.push(place.block);
      } else {
        seen.set(k, { by: [step.name], blocks: [place.block], cell: { f: place.f, u: place.u, s: place.s } });
      }
    }
  }

  for (const [k, entry] of seen) {
    if (entry.by.length < 2 || allowed.has(k)) continue;
    out.push({ cell: entry.cell, by: entry.by, blocks: entry.blocks });
  }
  return out;
}

/** Problems that make a blueprint unbuildable or unreadable, in the order worth fixing them. */
export function validate(blueprint: Blueprint): string[] {
  const problems: string[] = [];
  if (!blueprint.name) problems.push('a blueprint with no name cannot be reported when it fails');
  if (blueprint.steps.length === 0) problems.push(`${blueprint.name}: no steps, so nothing would be built`);

  const names = blueprint.steps.map((s) => s.name);
  if (new Set(names).size !== names.length) {
    problems.push(`${blueprint.name}: two steps share a name, so a failure could not say which one`);
  }
  for (const step of blueprint.steps) {
    if (!step.name) problems.push(`${blueprint.name}: an unnamed step`);
    if (step.places.length === 0) problems.push(`${blueprint.name}/${step.name}: places nothing`);
    for (const place of step.places) {
      if (!place.block.includes(':')) {
        problems.push(`${blueprint.name}/${step.name}: "${place.block}" is not a namespaced block id`);
      }
    }
  }
  for (const clash of overwrites(blueprint)) {
    problems.push(
      `${blueprint.name}: ${clash.by.join(' then ')} both write ${key(clash.cell)} ` +
        `(${clash.blocks.join(' then ')}). A later step silently replacing an earlier one is ` +
        `invisible in play — declare it in \`mayOverwrite\` if it is deliberate.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Shapes
//
// Deliberately few and deliberately rectangular. Every shape added here is another thing a
// measurement could be blaming instead of the game, and a facility you can describe in one
// sentence is one you can check by looking at it.
// ---------------------------------------------------------------------------

export interface Span {
  f: [number, number];
  u: [number, number];
  s: [number, number];
}

const range = (span: [number, number]): number[] => {
  const [lo, hi] = span[0] <= span[1] ? span : [span[1], span[0]];
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) out.push(n);
  return out;
};

/** Every cell in a box, filled with one block. */
export function fill(span: Span, block: string): Placement[] {
  const out: Placement[] = [];
  for (const f of range(span.f)) {
    for (const u of range(span.u)) {
      for (const s of range(span.s)) out.push({ f, u, s, block });
    }
  }
  return out;
}

/** A flat slab at one height. The floor of everything. */
export function slab(f: [number, number], s: [number, number], u: number, block: string): Placement[] {
  return fill({ f, u: [u, u], s }, block);
}

/** A vertical column: a drop shaft, a post, a marker pillar. */
export function column(f: number, s: number, u: [number, number], block: string): Placement[] {
  return fill({ f: [f, f], u, s: [s, s] }, block);
}

/** One block, where it matters that it is exactly one. */
export function at(f: number, u: number, s: number, block: string): Placement[] {
  return [{ f, u, s, block }];
}

/**
 * A hollow rim around a slab: a lip you cannot walk off by accident.
 *
 * Built as a ring rather than a box because a solid box would write the interior too, and then
 * every floor beneath it would show up as an overwrite.
 */
export function rim(f: [number, number], s: [number, number], u: number, block: string): Placement[] {
  const [f0, f1] = f[0] <= f[1] ? f : [f[1], f[0]];
  const [s0, s1] = s[0] <= s[1] ? s : [s[1], s[0]];
  const out: Placement[] = [];
  for (const ff of range([f0, f1])) {
    out.push({ f: ff, u, s: s0, block }, { f: ff, u, s: s1, block });
  }
  for (const ss of range([s0 + 1, s1 - 1])) {
    out.push({ f: f0, u, s: ss, block }, { f: f1, u, s: ss, block });
  }
  return out;
}
