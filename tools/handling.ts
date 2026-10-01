/**
 * Handling the player: how any test that moves the person does it, so it always looks the same.
 *
 * Set 2026-10-01 by the person being moved: tests may move them anywhere, teleport them, throw them
 * into things, as long as it is always visible that it is happening. So, every time:
 *
 *   1. a few words on the action bar, so they know it is the harness and not the game
 *   2. the camera pulls back above and behind them, facing them. A near move glides after them; a
 *      far one (past FAR) is a cut under a fade, waiting for the destination to load, because
 *      gliding out of loaded terrain into ungenerated void was the jarring part when watched
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

/** Point the free camera at the player from somewhere near `around`, easing if asked. */
async function frame(d: Director, around: Vec, easeTime?: number): Promise<void> {
  await d.program([
    { get: ['player'] },
    {
      call: ['player', 'camera', 'setCamera'],
      args: [
        'minecraft:free',
        {
          location: pulledBack(around),
          facingEntity: { $: 0 },
          ...(easeTime ? { easeOptions: { easeTime, easeType: 'InOutSine' } } : {}),
        },
      ],
    },
  ]);
}

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

/** Far enough that the destination is probably not loaded, so the move is covered by a fade. */
const FAR = 500;

/**
 * Run `act`, which moves the player from `from` towards `to`, inside the visible handling. Returns
 * whatever `act` returns. The player is put back where they were, facing the same way.
 */
export async function handled<T>(d: Director, words: string, from: Vec, to: Vec, act: () => Promise<T>): Promise<T> {
  const home = (await d.get('player.location')) as Vec;
  const rotation = (await d.call('player.getRotation')) as { x: number; y: number };
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  await d.call('player.onScreenDisplay.setActionBar', [`§e⟳ ${words}`]);
  await frame(d, from);
  try {
    const far = distance > FAR;
    // Cover a long jump in black while the destination generates, rather than show the void.
    if (far) {
      await d.call('player.camera.fade', [{ fadeTime: { fadeInTime: 0.3, holdTime: 2, fadeOutTime: 0.6 }, fadeColor: { red: 0, green: 0, blue: 0 } }]);
      await wait(300);
    }
    const out = await act();
    await landed(d, to);
    if (far) {
      // A CUT, NOT A GLIDE. Gliding from home to a far destination crosses everything between, out
      // of loaded terrain and through the void -- the jarring part. Under the fade the camera is
      // simply put where it ends up, and the picture comes back on the ground the player is on.
      await frame(d, to);
      await wait(1500);
      return out;
    }
    // Near moves stay inside loaded terrain, so they glide; further reads as slower.
    const ease = Math.min(1.5, 0.6 + Math.log10(1 + distance) * 0.4);
    await frame(d, to, ease);
    await wait(ease * 1000 + 500);
    return out;
  } finally {
    await d.call('player.teleport', [home, { rotation }]).catch(() => {});
    await d.call('player.camera.clear').catch(() => {});
    await d.call('player.onScreenDisplay.setActionBar', ['§7back']).catch(() => {});
  }
}
