/**
 * Handling the player: how any test that moves the person does it, so it always looks the same.
 *
 * Set 2026-10-01 by the person being moved: tests may move them anywhere, teleport them, throw them
 * into things, as long as it is always visible that it is happening. So, every time:
 *
 *   1. a few words on the action bar, so they know it is the harness and not the game
 *   2. the camera pulls back above and behind them, facing them. A near move glides after them; a
 *      far one (past FAR) is the satellite move: up over home, a hidden cut in the sky, down onto
 *      the destination once it has loaded. Both gliding out of loaded terrain and a bare cut read
 *      badly when watched on an iPad
 *   3. it is cleared afterwards, even if the test failed, so nobody is left in a free camera
 *   4. they end where they started, facing the same way
 *
 * A test that does not need the player should not use one. This is for the ones that do.
 */

import type { Director } from './director.ts';

export interface Vec {
  x: number;
  y: number;
  z: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Above and behind a point, far enough back to see the player in context. */
const pulledBack = (p: Vec): Vec => ({ x: p.x - 6, y: p.y + 5, z: p.z - 6 });

/** Put the free camera at `location`, facing the player, easing there if asked. */
async function place(d: Director, location: Vec, easeTime?: number): Promise<void> {
  await d.program([
    { get: ['player'] },
    {
      call: ['player', 'camera', 'setCamera'],
      args: [
        'minecraft:free',
        {
          location,
          facingEntity: { $: 0 },
          ...(easeTime ? { easeOptions: { easeTime, easeType: 'InOutSine' } } : {}),
        },
      ],
    },
  ]);
}

/** Point the free camera at the player from above and behind `around`, easing if asked. */
const frame = (d: Director, around: Vec, easeTime?: number) => place(d, pulledBack(around), easeTime);

/**
 * High over a point, looking down at it. Up here the ground is far away and every place looks
 * alike -- sky, haze, a distant floor -- which is what makes a cut between two of them invisible.
 * Higher for further jumps, so the climb itself says how far.
 */
const overhead = (p: Vec, distance: number): Vec => ({ x: p.x - 2, y: p.y + Math.min(260, 60 + 40 * Math.log10(distance)), z: p.z - 2 });

/**
 * Wait until the ground at `to` exists. A fresh far destination has no chunks yet when the player
 * arrives: easing the camera there showed void, while a second visit (chunks cached) showed terrain.
 * `getBlock` answers nothing in a chunk that is not loaded. Gives up after `ms` and moves on.
 */
async function landed(d: Director, to: Vec, ms = 6000): Promise<boolean> {
  const below = { x: Math.floor(to.x), y: Math.floor(to.y) - 1, z: Math.floor(to.z) };
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await d.call('player.dimension.getBlock', [below]).catch(() => null)) return true;
    await wait(250);
  }
  return false;
}

/**
 * Is the player still? The iPad this harness runs on has a broken screen that fires touches by
 * itself (docs/HARNESS.md). Touch input steering the player is the screen, not the game, and a
 * reading taken under it is about the screen. So before a test that needs the player still, wait
 * for two readings a second apart that agree; if they never do within `ms`, the caller sets that
 * one test aside for next time and carries on. Never a pause, never a finding.
 */
export async function settled(d: Director, ms = 15000): Promise<boolean> {
  const read = async () => {
    const [loc, rot] = (await Promise.all([d.get('player.location'), d.call('player.getRotation')])) as [Vec, { x: number; y: number }];
    return { loc, rot };
  };
  const deadline = Date.now() + ms;
  let a = await read();
  while (Date.now() < deadline) {
    await wait(1000);
    const b = await read();
    const moved = Math.hypot(b.loc.x - a.loc.x, b.loc.y - a.loc.y, b.loc.z - a.loc.z);
    const turned = Math.abs(b.rot.x - a.rot.x) + Math.abs(b.rot.y - a.rot.y);
    if (moved < 0.05 && turned < 1) return true;
    a = b;
  }
  return false;
}

/**
 * KNOW WHAT THE PLAYER IS BEING MADE TO SEE. A camera aimed at coordinates without looking once
 * showed treetops and a black roof instead of the goo wave it was pointed at: spruce leaves stood on
 * both sight lines, and the room had a ceiling. So a shot is chosen, not assumed: candidates are
 * tried in order and the first whose ray reaches the subject unobstructed wins. A ray that stops
 * inside `inside` (the subject's own box, when the subject is enclosed) counts as reaching it.
 * Returns the chosen spot and, for each rejected one, what was in the way.
 */
export async function aim(
  d: Director,
  subject: Vec,
  candidates: Vec[],
  inside?: { min: Vec; max: Vec },
): Promise<{ camera?: Vec; rejected: { at: Vec; blocked: string }[] }> {
  const rejected: { at: Vec; blocked: string }[] = [];
  const within = (p: Vec) => !!inside && [p.x, p.y, p.z].every((n, i) => n >= [inside.min.x, inside.min.y, inside.min.z][i]! && n <= [inside.max.x, inside.max.y, inside.max.z][i]!);
  for (const at of candidates) {
    const dir = { x: subject.x - at.x, y: subject.y - at.y, z: subject.z - at.z };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const hit = (await d.call('player.dimension.getBlockFromRay', [at, { x: dir.x / len, y: dir.y / len, z: dir.z / len }, { maxDistance: Math.max(0, len - 1.5) }]).catch(() => null)) as
      | { block?: { typeId?: string; location?: Vec } }
      | null;
    const where = hit?.block?.location;
    if (!hit || (where && within(where))) return { camera: at, rejected };
    rejected.push({ at, blocked: `${hit.block?.typeId ?? 'something'} at ${where ? `${where.x} ${where.y} ${where.z}` : '?'}` });
  }
  return { rejected };
}

/** Far enough that the destination is probably not loaded: past this, the satellite move. */
const FAR = 500;

/**
 * Run `act`, which moves the player from `from` towards `to`, inside the visible handling. Returns
 * whatever `act` returns. The player is put back where they were, facing the same way.
 */
export async function handled<T>(
  d: Director,
  words: string,
  from: Vec,
  to: Vec,
  act: () => Promise<T>,
  /** `stay`: a move that is the point, not a test -- the player is not put back afterwards. */
  opts: { stay?: boolean } = {},
): Promise<T> {
  const home = (await d.get('player.location')) as Vec;
  const rotation = (await d.call('player.getRotation')) as { x: number; y: number };
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  await d.call('player.onScreenDisplay.setActionBar', [`§e⟳ ${words}`]);
  await frame(d, from);
  try {
    // The satellite move for anything far -- or near but not loaded yet, since gliding into
    // ungenerated ground is the same void whatever the distance.
    const loaded = distance <= FAR && !!(await d.call('player.dimension.getBlock', [{ x: Math.floor(to.x), y: Math.floor(to.y) - 1, z: Math.floor(to.z) }]).catch(() => null));
    if (!loaded) {
      // THE SATELLITE MOVE. Gliding across a far jump crossed everything between, out of loaded
      // terrain and through the void; a bare cut read as going 100k in zero time. Instead the camera
      // climbs straight up over home, the cut happens up there behind a quick haze where both places
      // look alike, and it descends onto the destination once the ground there exists. The climb
      // and descent take longer the further the jump, so the distance is felt, never crossed.
      const climb = Math.min(2.5, 0.8 + 0.35 * Math.log10(distance));
      await place(d, overhead(from, distance), climb);
      await wait(climb * 1000);
      await d.call('player.camera.fade', [{ fadeTime: { fadeInTime: 0.2, holdTime: 0.5, fadeOutTime: 0.4 }, fadeColor: { red: 0.75, green: 0.82, blue: 0.9 } }]);
      await wait(200);
      const out = await act();
      await landed(d, to);
      await place(d, overhead(to, distance));
      await place(d, pulledBack(to), climb);
      await wait(climb * 1000 + 600);
      return out;
    }
    const out = await act();
    await landed(d, to);
    // Near moves stay inside loaded terrain, so they glide; further reads as slower.
    const ease = Math.min(1.5, 0.6 + Math.log10(1 + distance) * 0.4);
    await frame(d, to, ease);
    await wait(ease * 1000 + 500);
    return out;
  } finally {
    if (!opts.stay) await d.call('player.teleport', [home, { rotation }]).catch(() => {});
    await d.call('player.camera.clear').catch(() => {});
    await d.call('player.onScreenDisplay.setActionBar', ['§7back']).catch(() => {});
  }
}
