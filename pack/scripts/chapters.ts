/**
 * Chapters: build a facility from nothing, run the tests that need it, stop so it can be looked
 * at, then tear it down and build the next one.
 *
 * WHY NOT ONE TALL FACILITY HOLDING EVERYTHING. Because a building that holds everything is one
 * you have to be careful in — every probe sharing it can disturb every other, which is exactly
 * the failure the probe lanes were invented to paper over after two of them started sweeping each
 * other's entities and three readings in five came back looking like despawns. One chapter at a
 * time owns the whole site. Nothing else is standing while it runs, so there is nothing to
 * collide with and no lanes to get right.
 *
 * WHY NOT SHIP THE FACILITY IN THE WORLD. Because then its construction is never tested. A
 * pre-built facility was assembled once, on some afternoon when things happened to work, and
 * every session afterwards inherits that afternoon — including any bug that was present at bake
 * time and is now gone, or absent then and present now. Building floor-up on every run puts the
 * construction under test alongside the measurements, and a facility that can no longer be built
 * is itself a finding.
 *
 * IT HALTS BY DEFAULT, and that is the feature rather than a missing one. When a chapter finishes
 * it leaves the facility standing and says so; you go and look, and the next chapter only starts
 * when you ask. A run that swept through and demolished as it went would leave you with numbers
 * and no way to see why they were what they were.
 *
 * A BUILD THAT FAILS IS NOT TORN DOWN EITHER. It stops on the course that failed, names the step,
 * and leaves the half-built thing exactly where it stopped. The last complete course is the
 * diagnosis.
 */

import { fill, rim, slab, type Blueprint, type Cell } from './blueprint.ts';

const AT = 'bedshock:chapter_at';

const FLOOR = 'minecraft:smooth_stone';
const EDGE = 'minecraft:polished_andesite';
const MARK = 'minecraft:sea_lantern';

/**
 * The pad every chapter starts from: somewhere flat, lit, and edged so it is obvious where the
 * ground stops. Two hundred blocks up there is nothing to fall onto, so the rim is the only
 * warning there is.
 */
function pad(reach: number): Blueprint['steps'] {
  return [
    { name: 'the floor', places: slab([-reach, reach], [-reach, reach], -1, FLOOR) },
    { name: 'the edge', places: rim([-reach - 1, reach + 1], [-reach - 1, reach + 1], -1, EDGE) },
    {
      name: 'the corner lights',
      places: [reach, -reach].flatMap((f) =>
        [reach, -reach].map((s) => ({ f, u: -1, s, block: MARK })),
      ),
      // The lights sit ON the floor slab, which is legitimate and declared rather than silently
      // overwriting it.
      mayOverwrite: [reach, -reach].flatMap((f) => [reach, -reach].map((s) => ({ f, u: -1, s }))),
    },
  ];
}

export interface Chapter {
  name: string;
  /** One line, printed when it starts. What this act of the battery is about. */
  about: string;
  /** Probe names from the registry in `main.ts`, run in this order. */
  probes: string[];
  blueprint: Blueprint;
  /** Where to stand, and what to look at. Blueprint coordinates. */
  viewFrom?: Cell;
  lookAt?: Cell;
}

/**
 * The order is the build order, and it is deliberate: cheap and self-contained first.
 *
 * If a session is abandoned half way — and it will be, because a tablet is a tablet — the
 * chapters that needed nothing from the world have already reported.
 */
export const CHAPTERS: Chapter[] = [
  {
    name: 'items',
    about: 'What an item definition can declare and what the API sees of it. Needs ground and nothing else.',
    probes: ['durability', 'menu', 'dynprops', 'repair'],
    blueprint: { name: 'items', steps: pad(6) },
    viewFrom: { f: 0, u: 0, s: 0 },
  },
  {
    name: 'screens',
    about: 'Everything that is a picture: bars, glyphs, flipbooks, form icons. Read, not measured.',
    probes: ['ruler', 'glyphs', 'flipbook', 'formicon'],
    blueprint: { name: 'screens', steps: pad(6) },
    viewFrom: { f: 0, u: 0, s: 0 },
  },
  {
    name: 'hands',
    about: 'What a custom item looks like held: whether an attachable draws at all, where it sits, and whether it can read the item.',
    probes: ['attachable', 'attachable_pose'],
    blueprint: {
      name: 'hands',
      steps: [
        ...pad(8),
        {
          // A DARK BACKDROP, and it is apparatus rather than decoration. Every flag in the
          // candidate rig is a saturated primary, and reading four of them off a screenshot means
          // telling RED from WHITE against whatever happens to be behind the player. Two hundred
          // blocks up that is sky, which is neither.
          name: 'the backdrop',
          places: fill({ f: [-8, 8], u: [0, 5], s: [8, 8] }, 'minecraft:black_concrete'),
        },
      ],
    },
    // Standing well back from the backdrop, facing it. The whole rig hangs off the player, so what
    // has to be in shot is the PLAYER — this is the one chapter where the thing to look at is you.
    viewFrom: { f: 0, u: 0, s: -2 },
    lookAt: { f: 0, u: 1, s: 8 },
  },
  {
    name: 'containers',
    about: 'Custom entities carrying containers, how many of their slots you can reach, and whether one can be used as a stash.',
    probes: ['container', 'stash'],
    blueprint: {
      name: 'containers',
      steps: [
        ...pad(10),
        {
          // A back wall so the container entities have something to stand against and cannot
          // wander out of view, and so a screenshot has a consistent backdrop.
          name: 'the back wall',
          places: fill({ f: [-10, 10], u: [0, 3], s: [10, 10] }, EDGE),
        },
      ],
    },
    viewFrom: { f: 0, u: 0, s: -4 },
    lookAt: { f: 0, u: 1, s: 4 },
  },
  {
    name: 'equipment',
    about: 'The off-hand: what script can put there and whether it stays. Expected to be no.',
    probes: ['offhand'],
    blueprint: { name: 'equipment', steps: pad(4) },
    viewFrom: { f: 0, u: 0, s: 0 },
  },
  {
    name: 'physics',
    about: 'The measured constants: gravity, throw distance, knockback, the anvil clearance.',
    probes: ['fallingblock', 'fallcurve', 'anvilgap', 'throw', 'knockback'],
    blueprint: {
      name: 'physics',
      steps: [
        // Long, because the throw probe needs a run and the knockback probe needs room behind.
        ...pad(28),
        {
          // A measured rail: a marker every four blocks along the throw lane, so a distance can be
          // eyeballed against the number the probe reports. If they disagree, one of them is wrong
          // and the rail is the one you can check.
          name: 'the measuring rail',
          places: [4, 8, 12, 16, 20, 24].map((f) => ({ f, u: -1, s: -1, block: MARK })),
          mayOverwrite: [4, 8, 12, 16, 20, 24].map((f) => ({ f, u: -1, s: -1 })),
        },
      ],
    },
    viewFrom: { f: -2, u: 0, s: 0 },
    lookAt: { f: 20, u: 0, s: 0 },
  },
  {
    name: 'distribution',
    about: 'How this pack got here, which decides how expensive everything else is to repeat.',
    probes: ['distribution'],
    blueprint: { name: 'distribution', steps: pad(3) },
    viewFrom: { f: 0, u: 0, s: 0 },
  },
];

export function chapterNamed(name: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.name === name);
}
