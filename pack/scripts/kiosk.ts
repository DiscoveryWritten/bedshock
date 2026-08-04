/**
 * Starting the battery without typing anything.
 *
 * THE PREMISE OF THIS PACK IS THAT SOMEBODY CAN DOWNLOAD IT AND GET ANSWERS. Every step between
 * importing a world and answering a question is a step where that stops being true, and typing
 * `/scriptevent bedshock:session` on a phone is the worst of them: a slash command, on a touch
 * keyboard, that autocorrects, with a colon in it, which does nothing visible if you get it
 * wrong. Reported from the first real run — the pack worked and the person had no way in.
 *
 * So there are three ways to start, and none of them involves the chat box:
 *
 *   A BUTTON. Any button, anywhere in the world. Not one at a remembered coordinate — matching
 *   a position would mean a button that stops working the day somebody moves it or the world is
 *   regenerated, and the failure would look like the pack being broken. This is a probe world
 *   with no redstone in it; a button press here means one thing.
 *
 *   THE ITEM YOU ARE ALREADY HOLDING. Handed over on first join, in the first slot, so the very
 *   first reflex anyone has in Minecraft — tap with what is in your hand — is the right one.
 *
 *   THE COMMAND, still, for a server or a second run.
 *
 * AND A KIOSK IS BUILT WHERE YOU SPAWN, because a button you have to place yourself is a button
 * that needs a creative menu, a search, and knowing what you are looking for.
 */

import { ItemStack, system, world, type Player, type Vector3 } from '@minecraft/server';

import { IDS, NAMESPACE } from './generated.ts';
import { makeCtx } from './emit.ts';
import * as session from './session.ts';

/** Set once the kiosk exists, so re-joining does not rebuild it on top of itself. */
const BUILT = 'bedshock:kiosk_built';

/** A glowing plinth is findable at a glance; a stone one is scenery. */
const PLINTH = 'minecraft:sea_lantern';
const BUTTON = 'minecraft:stone_button';

function begin(player: Player, why: string): void {
  if (session.isRunning()) {
    player.onScreenDisplay.setActionBar('§7already running§r');
    return;
  }
  console.warn(`BEDSHOCK NOTE session started by ${why}`);
  session.start(makeCtx(player), player, false);
}

/**
 * Put the plinth in front of the player, with the button on TOP of it.
 *
 * Facing up rather than at them, deliberately. A wall button has to be given a `facing_direction`
 * derived from where the player happens to be looking, and getting that wrong puts the button
 * inside the plinth where it cannot be pressed — a failure that looks identical to the pack not
 * working. Up is up from every angle.
 */
function buildKiosk(player: Player): void {
  const view = player.getViewDirection();
  // Two blocks out along whichever horizontal axis they are most facing, so the kiosk lands in
  // front of them rather than under their feet, whatever direction they spawned looking.
  const step = Math.abs(view.x) > Math.abs(view.z)
    ? { x: Math.sign(view.x) * 2, z: 0 }
    : { x: 0, z: Math.sign(view.z) * 2 || 2 };

  const at = player.location;
  const base: Vector3 = { x: Math.floor(at.x) + step.x, y: Math.floor(at.y), z: Math.floor(at.z) + step.z };
  const top: Vector3 = { x: base.x, y: base.y + 1, z: base.z };

  try {
    player.dimension.getBlock(base)?.setType(PLINTH);
    const button = player.dimension.getBlock(top);
    button?.setType(BUTTON);
    // `facing_direction: 1` is up. Set through permutation because the default for a freshly
    // placed button is not guaranteed to be the one that sits on a floor.
    const permutation = button?.permutation.withState('facing_direction', 1);
    if (permutation) button?.setPermutation(permutation);
    world.setDynamicProperty(BUILT, true);
  } catch {
    // An unloaded chunk or a protected block. The item and the command still work, and a kiosk
    // that could not be built must not stop the pack from being usable.
  }
}

function greet(player: Player): void {
  try {
    const inventory = player.getComponent('minecraft:inventory')?.container;
    if (inventory) {
      const starter = new ItemStack(IDS.start, 1);
      starter.nameTag = '§a§lTAP TO START§r';
      // Slot 0, so it is the selected one on arrival and tapping needs no inventory at all.
      inventory.setItem(0, starter);
    }
  } catch {
    /* the button and the command remain */
  }

  if (!world.getDynamicProperty(BUILT)) buildKiosk(player);

  player.onScreenDisplay.setTitle('§a§lTAP TO START', {
    subtitle: '§fthe button in front of you, or the item in your hand§r',
    fadeInDuration: 5,
    stayDuration: 140,
    fadeOutDuration: 20,
  });
}

export function install(): void {
  // Each subscription is separately guarded. These events are not all present on every engine
  // version this pack might be pointed at, and one missing event must not take the other two --
  // or the whole pack -- down with it.
  try {
    world.afterEvents.playerSpawn.subscribe((event) => {
      if (!event.initialSpawn) return;
      // A tick later: on the very first join the inventory and the chunk are not both ready, and
      // a kiosk built into an unloaded chunk is a kiosk nobody can see.
      system.runTimeout(() => greet(event.player), 20);
    });
  } catch {
    /* no spawn event: the command still works */
  }

  try {
    world.afterEvents.buttonPush.subscribe((event) => {
      const source = event.source;
      if (source?.typeId !== 'minecraft:player') return;
      begin(source as Player, 'a button');
    });
  } catch {
    /* no button event: the item still works */
  }

  try {
    world.afterEvents.itemUse.subscribe((event) => {
      if (event.itemStack?.typeId !== IDS.start) return;
      begin(event.source, 'the start item');
    });
  } catch {
    /* no itemUse event: the button still works */
  }

  void NAMESPACE;
}
