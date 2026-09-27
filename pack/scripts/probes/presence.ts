/**
 * Presence: does script see the person playing, and can it act on them -- with nothing asked of
 * them at all.
 *
 * THE FIRST THING A CLIENT RUN HAS TO PROVE, and it asks for no input. It runs by itself a moment
 * after a player spawns, reports four rows, and then keeps a quiet heartbeat going: where the
 * player is, what they hold, what they are looking at, how they are playing. All of it goes to the
 * log, where the bridge (tools/bridge.py) catches it. Nothing here waits on the player, prints a
 * code, or needs reading off a screen.
 *
 *   presence.player.visible_to_script     world.getPlayers() has them
 *   presence.player.where_and_looking     position, dimension, view, the block in view
 *   presence.player.input_readable        touch / pad / keyboard, movement, jump and sneak
 *   presence.player.can_be_acted_on       an effect applied by script reads back on them
 */

import { world, type Player } from '@minecraft/server';

import { firstLine, result, skipped, type Ctx } from '../emit.ts';

const ROW = {
  visible: 'presence.player.visible_to_script',
  where: 'presence.player.where_and_looking',
  input: 'presence.player.input_readable',
  acted: 'presence.player.can_be_acted_on',
} as const;

const round = (n: number) => Math.round(n * 100) / 100;
const v3 = (v: { x: number; y: number; z: number }) => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

/** What script can see of a player right now, in one object. Shared by the rows and the heartbeat. */
export function snapshot(p: Player) {
  const hit = p.getBlockFromViewDirection({ maxDistance: 16 });
  const held = p.getComponent('minecraft:inventory')?.container.getItem(p.selectedSlotIndex);
  const input = p.inputInfo;
  return {
    name: p.name,
    dimension: p.dimension.id,
    at: v3(p.location),
    view: v3(p.getViewDirection()),
    looking_at: hit ? { block: hit.block.typeId, at: hit.block.location } : null,
    holding: held ? `${held.typeId} x${held.amount}` : null,
    input: {
      mode: input.lastInputModeUsed,
      move: { x: round(input.getMovementVector().x), y: round(input.getMovementVector().y) },
      jump: input.getButtonState('Jump' as never),
      sneak: input.getButtonState('Sneak' as never),
    },
  };
}

export function run(ctx: Ctx): void {
  const player = ctx.player ?? world.getPlayers()[0];
  if (!player) {
    for (const r of Object.values(ROW)) skipped(ctx, r, 'no player connected (headless run)');
    return;
  }

  const players = world.getPlayers();
  result(ctx, ROW.visible, players.some((p) => p.id === player.id) ? 'YES' : 'NO',
    { name: player.name, players: players.length }, `script sees ${player.name}`);

  let snap: ReturnType<typeof snapshot> | undefined;
  try {
    snap = snapshot(player);
    const finite = [snap.at.x, snap.at.y, snap.at.z].every(Number.isFinite);
    result(ctx, ROW.where, finite ? 'YES' : 'NO', { at: snap.at, dimension: snap.dimension, view: snap.view, looking_at: snap.looking_at },
      `at ${snap.at.x}, ${snap.at.y}, ${snap.at.z} in ${snap.dimension}`);
  } catch (err) {
    result(ctx, ROW.where, 'INCONCLUSIVE', undefined, `could not read position: ${firstLine(err)}`);
  }

  if (snap) {
    const known = ['Gamepad', 'KeyboardAndMouse', 'MotionController', 'Touch'].includes(String(snap.input.mode));
    result(ctx, ROW.input, known ? 'YES' : 'NO', { input: snap.input },
      known ? `playing by ${snap.input.mode}` : `input mode read as ${String(snap.input.mode)}`);
  } else {
    result(ctx, ROW.input, 'INCONCLUSIVE', undefined, 'no snapshot to read input from');
  }

  // Something harmless, short, and invisible: night vision for two seconds, no particles. The
  // question is only whether script's hand reaches the player and the game agrees it did.
  try {
    player.addEffect('night_vision', 40, { showParticles: false });
    const effect = player.getEffect('night_vision');
    result(ctx, ROW.acted, effect ? 'YES' : 'NO', { effect: effect?.typeId ?? null, duration: effect?.duration ?? null },
      effect ? 'an effect applied by script is on the player' : 'the effect did not take');
    player.removeEffect('night_vision');
  } catch (err) {
    result(ctx, ROW.acted, 'INCONCLUSIVE', undefined, `could not apply an effect: ${firstLine(err)}`);
  }
}
