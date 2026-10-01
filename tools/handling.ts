/**
 * Handling the player: how any test that moves the person does it, so it always looks the same.
 *
 * Set 2026-10-01 by the person being moved: tests may move them anywhere, teleport them, throw them
 * into things, as long as it is always visible that it is happening. So, every time:
 *
 *   1. a few words on the action bar, so they know it is the harness and not the game
 *   2. the camera pulls back above and behind them, facing them, and eases to follow the move --
 *      slower the further it goes
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
    const out = await act();
    // Further means slower, so a long jump reads as a long jump. Capped so nothing drags.
    const ease = Math.min(2.5, 0.6 + Math.log10(1 + distance) * 0.4);
    await frame(d, to, ease);
    await wait(ease * 1000 + 500);
    return out;
  } finally {
    await d.call('player.teleport', [home, { rotation }]).catch(() => {});
    await d.call('player.camera.clear').catch(() => {});
    await d.call('player.onScreenDisplay.setActionBar', ['§7back']).catch(() => {});
  }
}
