/**
 * The lab: build a 16^3 room beside the player, terraform its inside, save it as a structure, put it
 * back somewhere else, and let the game compare the two block for block.
 *
 * Practice for two things the mods will lean on: shaping terrain inside a module (the arena's rooms
 * are 16^3), and serialising what was made (the world-as-storage rows). Snow layers stand in for goo:
 * same eighths of a block, same height state. It needs nothing new in the pack -- every step is
 * reflection over the game's own API, unrolled here into programs, and the game's own
 * `/testforblocks` is the judge of "exactly the same".
 *
 * Costs are read in ticks from the device's own clock (system.currentTick), so they are the device's,
 * not the network's.
 */

import type { Director, Step } from './director.ts';
import type { Vec } from './handling.ts';

const SIZE = 16;
const SHELL = 'minecraft:smooth_quartz';
const FLOOR = 'minecraft:black_concrete';

export interface LabResult {
  origin: Vec;
  ticks: { shell: number; terrain: number; save: number; restore: number };
  steps: number;
  identicalCopy: boolean;
  identicalAfterRebuild: boolean;
  notes: string[];
}

const at = (o: Vec, x: number, y: number, z: number): Vec => ({ x: o.x + x, y: o.y + y, z: o.z + z });

/** A hill field that is the same every run, so two runs can be compared. 1..10 tall. */
const height = (x: number, z: number) => Math.max(1, Math.min(10, Math.round(4 + 3 * Math.sin(x / 2.3) * Math.cos(z / 2.9) + (x + z) / 7)));
/** The "goo": a snow layer of 1..8 eighths on every hilltop, varying across the room. */
const eighths = (x: number, z: number) => ((x * 3 + z * 5) % 8) + 1;

async function tick(d: Director): Promise<number> {
  return (await d.get('system.currentTick')) as number;
}

/** fillBlocks over [a, b] with `block`, as steps. */
function fill(a: Vec, b: Vec, block: string): Step[] {
  return [{ new: ['mc', 'BlockVolume'], args: [a, b] }, { call: ['player', 'dimension', 'fillBlocks'], args: [{ $: -1 }, block] }];
}

/** Resolve `{ $: -1 }` to "the step just before this one" so step lists can be built in pieces. */
function link(steps: Step[]): Step[] {
  return steps.map((s, i) => ({
    ...s,
    ...(s.args ? { args: s.args.map((a) => (a && typeof a === 'object' && (a as { $?: number }).$ === -1 ? { $: i - 1 } : a)) } : {}),
  }));
}

async function run(d: Director, steps: Step[]): Promise<number> {
  const before = await tick(d);
  await d.program(link(steps));
  return (await tick(d)) - before;
}

async function same(d: Director, a: Vec, b: Vec, dest: Vec): Promise<boolean> {
  const cmd = `testforblocks ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${dest.x} ${dest.y} ${dest.z} all`;
  try {
    const r = (await d.call('player.dimension.runCommand', [cmd])) as { successCount?: number };
    return (r?.successCount ?? 0) > 0;
  } catch {
    // testforblocks reports a mismatch by failing.
    return false;
  }
}

export async function lab(d: Director): Promise<LabResult> {
  const me = (await d.get('player.location')) as Vec;
  // Beside the player, not under them: 4 blocks out along x, floor level with their feet.
  const o = { x: Math.floor(me.x) + 4, y: Math.floor(me.y), z: Math.floor(me.z) - 8 };
  const far = at(o, SIZE - 1, SIZE - 1, SIZE - 1);
  const notes: string[] = [];

  // The shell: quartz walls, black floor and ceiling, air inside.
  const shell = await run(d, [
    ...fill(o, far, SHELL),
    ...fill(o, at(o, SIZE - 1, 0, SIZE - 1), FLOOR),
    ...fill(at(o, 0, SIZE - 1, 0), far, FLOOR),
    ...fill(at(o, 1, 1, 1), at(o, SIZE - 2, SIZE - 2, SIZE - 2), 'minecraft:air'),
  ]);

  // Terrain: a column of stone per cell with grass on top, then a snow layer of n eighths. One
  // program per row, so no request is enormous.
  let terrain = 0;
  let steps = 0;
  for (let x = 1; x <= SIZE - 2; x++) {
    const row: Step[] = [];
    for (let z = 1; z <= SIZE - 2; z++) {
      const h = height(x, z);
      row.push(...fill(at(o, x, 1, z), at(o, x, h, z), 'minecraft:stone'));
      row.push(...fill(at(o, x, h, z), at(o, x, h, z), 'minecraft:grass_block'));
      row.push({ call: ['mc', 'BlockPermutation', 'resolve'], args: ['minecraft:snow_layer', { height: eighths(x, z) - 1 }] });
      row.push({ call: ['player', 'dimension', 'setBlockPermutation'], args: [at(o, x, h + 1, z), { $: -1 }] });
    }
    steps += row.length;
    terrain += await run(d, row);
  }

  // Serialise it: a World-mode structure the save file keeps.
  const id = 'bedshock:lab_room';
  await d.call('world.structureManager.delete', [id]).catch(() => {});
  const before = await tick(d);
  await d.program([
    { get: ['player', 'dimension'] },
    { call: ['world', 'structureManager', 'createFromWorld'], args: [id, { $: 0 }, o, far, { saveMode: 'World', includeEntities: false }] },
  ]);
  const save = (await tick(d)) - before;

  // A copy beside it, then compare.
  const copyAt = at(o, SIZE + 2, 0, 0);
  const restoreStart = await tick(d);
  await d.program([{ get: ['player', 'dimension'] }, { call: ['world', 'structureManager', 'place'], args: [id, { $: 0 }, copyAt] }]);
  const restore = (await tick(d)) - restoreStart;
  const identicalCopy = await same(d, o, far, copyAt);

  // The harder test: tear the original down and rebuild it from the save alone.
  await d.program(link(fill(o, far, 'minecraft:air')));
  await d.program([{ get: ['player', 'dimension'] }, { call: ['world', 'structureManager', 'place'], args: [id, { $: 0 }, o] }]);
  const identicalAfterRebuild = await same(d, o, far, copyAt);

  if (!identicalCopy) notes.push('the placed copy differs from the original');
  if (!identicalAfterRebuild) notes.push('the room rebuilt from the save differs from the copy');
  return { origin: o, ticks: { shell, terrain, save, restore }, steps, identicalCopy, identicalAfterRebuild, notes };
}

