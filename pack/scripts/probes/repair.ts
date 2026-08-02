/**
 * Can anything OUTSIDE this pack write to a custom item's `damage`?
 *
 * WHY IT MATTERS, and it is a hazard rather than a curiosity. If durability carries packed
 * state, then any external write corrupts that state with no error and no visible cause.
 * Mending is the worst of it because it fires continuously during ordinary play — a player
 * collecting XP would silently rewrite a gun's colour and active chamber, and nothing anywhere
 * would say why.
 *
 * The probe item is the only ENCHANTABLE thing in this pack, deliberately, and it still omits
 * `minecraft:repairable` — because that omission is itself the mitigation being tested.
 * Declaring it would answer the question by construction.
 *
 * ENTIRELY OBSERVED, unavoidably: it needs a player to walk to an anvil, to hold an enchanted
 * item while XP comes in, to use the thing twenty times. What script can do is stamp the damage
 * it wrote into the item's name, so the before-and-after is legible on the item itself rather
 * than remembered.
 */

import { ItemStack } from '@minecraft/server';

import { IDS } from '../generated.ts';
import { look, skipped, type Ctx } from '../emit.ts';

const ROWS = [
  'item.durability.mending_can_reach_a_custom_item',
  'item.durability.anvil_or_grindstone_can_reach_a_custom_item',
  'item.durability.omitting_repairable_blocks_external_writes',
  'item.durability.ordinary_use_consumes_it',
];

/** Half-worn, so a write in EITHER direction has somewhere to go. */
const START_DAMAGE = 120;

export function run(ctx: Ctx): void {
  if (!ctx.player) {
    for (const id of ROWS) skipped(ctx, id, 'no player connected (headless run) — an anvil needs somebody to walk to it');
    return;
  }

  const stack = new ItemStack(IDS.repair, 1);
  const durability = stack.getComponent('minecraft:durability');
  let wrote = -1;
  if (durability) {
    durability.damage = START_DAMAGE;
    // Read back rather than assumed. If the write did not take, every later reading is against
    // a number nobody set, and the name is the only thing on screen that would say so.
    wrote = durability.damage;
  }
  stack.nameTag = `damage ${wrote}/${durability?.maxDurability ?? '??'} — re-read me`;

  const inventory = ctx.player.getComponent('minecraft:inventory')?.container;
  if (inventory && inventory.emptySlotsCount > 0) inventory.addItem(stack);
  else ctx.player.dimension.spawnItem(stack, ctx.player.location);

  if (wrote !== START_DAMAGE) {
    ctx.say(`§cThe damage write did not take§r (asked ${START_DAMAGE}, got ${wrote}). Nothing below is readable.`);
    return;
  }

  ctx.say(
    `§7Given you an item at damage §e${wrote}§7. It declares no \`minecraft:repairable\`, which is ` +
      'the mitigation being tested. Re-read the number off its NAME after each attempt — ' +
      '`/scriptevent bedshock:probe repair` stamps a fresh one.§r',
  );

  look(ctx, ROWS[0]!, `put Mending on it, collect XP, then check whether the damage moved from ${wrote}`);
  look(ctx, ROWS[1]!, 'take it to an anvil, then a grindstone. Does either offer to repair or strip it?');
  look(ctx, ROWS[2]!, 'answer this last: did omitting `minecraft:repairable` keep every route out?');
  look(ctx, ROWS[3]!, `use it twenty times and re-check. Ordinary use drifting is worse than an external write — there is no single event to point at`);
}
