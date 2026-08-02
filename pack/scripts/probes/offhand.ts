/**
 * Does the off-hand keep an item it would not normally accept?
 *
 * WHY IT MATTERS. The off-hand only accepts items whose definition permits it, so a player
 * cannot put an arbitrary item there by hand. Script *can*. If a script-placed item STAYS, the
 * off-hand becomes free in-world rendering of an arbitrary item — modded ones included — with
 * no attachable work at all, which is a shortcut around a whole class of display problem.
 *
 * ACCEPTANCE BY THE API IS NOT PERSISTENCE, and separating those is the entire design of this
 * probe. The call succeeds and reads back correctly; the client ejects the item some seconds
 * later. A probe that read the slot once would report a confident and wrong YES.
 *
 * So there are two reads, and the delay between them is a parameter rather than a guess:
 * immediately, to prove the write landed, and again after `settle_ticks`. Both go in the
 * measurement, because "never arrived" and "arrived and was ejected" are different findings
 * with different workarounds.
 *
 * Needs a player — a headless server has no equipment to write to — but needs no eyes, so it
 * is automated rather than observed.
 */

import { EquipmentSlot, ItemStack, system, type Player } from '@minecraft/server';

import { IDS, PARAMS } from '../generated.ts';
import { result, skipped, willReportLater, type Ctx } from '../emit.ts';

function equipment(player: Player) {
  return player.getComponent('minecraft:equippable');
}

function offhandId(player: Player): string | undefined {
  try {
    return equipment(player)?.getEquipment(EquipmentSlot.Offhand)?.typeId;
  } catch {
    return undefined;
  }
}

/**
 * One arm of the comparison: place `itemId`, read it back at once and again after a delay.
 *
 * `after` is delivered asynchronously because the ejection is not instant and there is no
 * event for it. Everything else in this battery is synchronous; this one cannot be.
 */
function trial(
  ctx: Ctx,
  player: Player,
  itemId: string,
  then: (r: { accepted: boolean; immediate?: string; after?: string }) => void,
): void {
  let accepted = false;
  try {
    equipment(player)!.setEquipment(EquipmentSlot.Offhand, new ItemStack(itemId, 1));
    accepted = true;
  } catch {
    then({ accepted: false });
    return;
  }
  const immediate = offhandId(player);
  system.runTimeout(() => {
    then({ accepted, ...(immediate ? { immediate } : {}), ...(offhandId(player) ? { after: offhandId(player)! } : {}) });
  }, PARAMS.offhand.settle_ticks);
}

export function run(ctx: Ctx): void {
  const player = ctx.player;
  if (!player) {
    for (const id of [
      'equipment.offhand.accepts_a_script_placed_item',
      'equipment.offhand.script_placed_item_persists',
      'equipment.offhand.custom_item_declaring_allow_off_hand_persists',
    ]) {
      skipped(ctx, id, 'no player connected (headless run) — there is no off-hand to write to');
    }
    return;
  }

  // Refuse to run over an occupied slot. On one earlier run the probe skipped itself because
  // the off-hand already held a custom item, and that skip was itself informative — but
  // silently overwriting whatever is there would destroy it.
  const occupied = offhandId(player);
  if (occupied) {
    ctx.say(`§eOff-hand already holds ${occupied}.§r Empty it and re-run, or this probe would destroy it.`);
    return;
  }

  const arbitrary = PARAMS.offhand.arbitrary_item;

  // Two chained settle delays, so this finishes several seconds after `run` returns. `done()`
  // waits for the release below rather than printing its marker over the top of these results.
  const reported = willReportLater('offhand');

  trial(ctx, player, arbitrary, (vanilla) => {
    result(
      ctx,
      'equipment.offhand.accepts_a_script_placed_item',
      vanilla.accepted ? 'YES' : 'NO',
      { item: arbitrary, ...vanilla },
      vanilla.accepted ? 'setEquipment succeeded on a slot that would refuse the item by hand' : 'the call itself was refused',
    );

    if (!vanilla.accepted) {
      skipped(ctx, 'equipment.offhand.script_placed_item_persists', 'the write never landed, so persistence is not measurable');
    } else if (!vanilla.immediate) {
      result(ctx, 'equipment.offhand.script_placed_item_persists', 'INCONCLUSIVE', vanilla,
        'the call succeeded but the slot read back empty at once — the apparatus, not the game');
    } else {
      const persisted = vanilla.after === arbitrary;
      result(
        ctx,
        'equipment.offhand.script_placed_item_persists',
        persisted ? 'YES' : 'NO',
        { item: arbitrary, settle_ticks: PARAMS.offhand.settle_ticks, ...vanilla },
        persisted
          ? 'still there after the settle delay — the off-hand renders arbitrary items for free'
          : 'read back correctly and then vanished: the client ejects items the slot would not accept',
      );
    }

    // The other arm, and it is what turns a flat "the off-hand is out" into something narrower.
    // Our own item declares `allow_off_hand`. If it stays and the vanilla one does not, the
    // ejection is about the ITEM rather than about the slot.
    try {
      equipment(player)!.setEquipment(EquipmentSlot.Offhand, undefined);
    } catch {
      /* about to overwrite it anyway */
    }
    trial(ctx, player, IDS.offhand_custom, (custom) => {
      const persisted = custom.after === IDS.offhand_custom;
      result(
        ctx,
        'equipment.offhand.custom_item_declaring_allow_off_hand_persists',
        !custom.accepted ? 'INCONCLUSIVE' : persisted ? 'YES' : 'NO',
        { item: IDS.offhand_custom, settle_ticks: PARAMS.offhand.settle_ticks, ...custom },
        persisted
          ? 'an item declaring allow_off_hand stays, so the limit is the item and not the slot'
          : 'even an item declaring allow_off_hand was ejected',
      );
      try {
        equipment(player)!.setEquipment(EquipmentSlot.Offhand, undefined);
      } catch {
        /* leaving it is harmless */
      }
      reported();
    });
  });
}
