/**
 * Does the off-hand keep an item it would not normally accept?
 *
 * THE SLOT A MOD AUTHOR HAS TO CONTORT AROUND. The off-hand only accepts items whose definition
 * permits it, so a player cannot put an arbitrary item there by hand. Script *can*. If a
 * script-placed item STAYS, the off-hand becomes free in-world rendering of an arbitrary item —
 * modded ones included — with no attachable work at all, which is a shortcut around a whole
 * class of display problem.
 *
 * It does not stay. That is the answer, and this probe exists to keep proving it, in enough
 * detail that a design can be built around the shape of the limit rather than a flat no.
 *
 * ACCEPTANCE BY THE API IS NOT PERSISTENCE, and separating those is the oldest part of this
 * probe's design. The call succeeds and reads back correctly; the client ejects the item some
 * seconds later. A probe that read the slot once would report a confident and wrong YES. So
 * there are two reads — immediately, to prove the write landed, and again after `settle_ticks` —
 * and both go in the measurement, because "never arrived" and "arrived and was ejected" are
 * different findings with different workarounds.
 *
 * FOUR ARMS, and each one exists because the others cannot answer for it:
 *
 *   THE CONTROL. A shield: an item the off-hand is supposed to take. It is the row that is
 *   SUPPOSED to pass, and if it does not, this probe is broken and every negative below is
 *   measuring the apparatus. Without it, a probe that had silently stopped writing anything at
 *   all would produce exactly the same confident row of NOs as one working perfectly — and a
 *   manifest people design around would be built on it.
 *
 *   THE SPREAD. Four vanilla items across four kinds, not one. "Arbitrary items are ejected"
 *   and "a diamond is ejected" are different claims, and only the first is worth publishing.
 *
 *   OUR OWN ITEM, declaring `allow_off_hand`. If ours stays and vanilla's does not, the limit is
 *   the ITEM rather than the slot — a much narrower and more useful statement than "the off-hand
 *   is out".
 *
 *   WHERE THE EJECTED ITEM WENT. Everything above asks whether a trick works. This asks what it
 *   costs when it does not. An ejection that returns the item is a failed effect; an ejection
 *   that destroys it is a pack eating somebody's diamonds.
 *
 * Needs a player — a headless server has no equipment to write to — but needs no eyes, so it is
 * automated rather than observed.
 */

import { EquipmentSlot, ItemStack, system, type Container, type Player } from '@minecraft/server';

import { IDS, PARAMS } from '../generated.ts';
import { firstLine, result, skipped, willReportLater, type Ctx } from '../emit.ts';

const CONTROL = 'equipment.offhand.vanilla_permitted_item_persists';
const ACCEPTS = 'equipment.offhand.accepts_a_script_placed_item';
const PERSISTS = 'equipment.offhand.script_placed_item_persists';
const CUSTOM = 'equipment.offhand.custom_item_declaring_allow_off_hand_persists';
const SURVIVES = 'equipment.offhand.ejected_item_survives';

const ALL = [CONTROL, ACCEPTS, PERSISTS, CUSTOM, SURVIVES];

function equipment(player: Player) {
  return player.getComponent('minecraft:equippable');
}

function inventory(player: Player): Container | undefined {
  return player.getComponent('minecraft:inventory')?.container;
}

function offhandId(player: Player): string | undefined {
  try {
    return equipment(player)?.getEquipment(EquipmentSlot.Offhand)?.typeId;
  } catch {
    return undefined;
  }
}

function clearOffhand(player: Player): void {
  try {
    equipment(player)!.setEquipment(EquipmentSlot.Offhand, undefined);
  } catch {
    // About to be overwritten, or the run is ending. Neither is worth a line.
  }
}

/** How many of `itemId` the player is carrying, so an ejection back into it is visible. */
function carried(player: Player, itemId: string): number {
  const container = inventory(player);
  if (!container) return 0;
  let n = 0;
  for (let slot = 0; slot < container.size; slot++) {
    const stack = container.getItem(slot);
    if (stack?.typeId === itemId) n += stack.amount;
  }
  return n;
}

/** Loose copies of `itemId` on the ground near the player. */
function onTheFloor(player: Player, itemId: string): number {
  try {
    return player.dimension
      .getEntities({ type: 'minecraft:item', location: player.location, maxDistance: 8 })
      .filter((e) => e.getComponent('minecraft:item')?.itemStack?.typeId === itemId).length;
  } catch {
    return 0;
  }
}

interface Trial {
  item: string;
  /** Did `setEquipment` itself succeed? */
  accepted: boolean;
  /** What the slot held right after the write, proving it landed. */
  immediate?: string;
  /** What it held after the settle delay. */
  after?: string;
  /** Whether the item is anywhere else afterwards, for the survival arm. */
  carriedBefore?: number;
  carriedAfter?: number;
  floorAfter?: number;
  error?: string;
}

/**
 * Place one item, read it back at once and again after a delay.
 *
 * `then` is called asynchronously because the ejection is not instant and there is no event for
 * it. Everything else in this battery is synchronous; this one cannot be.
 */
function place(player: Player, item: string, then: (t: Trial) => void): void {
  const carriedBefore = carried(player, item);
  try {
    equipment(player)!.setEquipment(EquipmentSlot.Offhand, new ItemStack(item, 1));
  } catch (err) {
    then({ item, accepted: false, error: firstLine(err), carriedBefore });
    return;
  }
  const immediate = offhandId(player);
  system.runTimeout(() => {
    then({
      item,
      accepted: true,
      ...(immediate ? { immediate } : {}),
      ...(offhandId(player) ? { after: offhandId(player)! } : {}),
      carriedBefore,
      carriedAfter: carried(player, item),
      floorAfter: onTheFloor(player, item),
    });
  }, PARAMS.offhand.settle_ticks);
}

/** Run `place` over several items in turn, then hand back every trial. */
function placeEach(player: Player, items: readonly string[], then: (all: Trial[]) => void): void {
  const done: Trial[] = [];
  const next = (i: number): void => {
    if (i >= items.length) {
      then(done);
      return;
    }
    clearOffhand(player);
    place(player, items[i]!, (t) => {
      done.push(t);
      next(i + 1);
    });
  };
  next(0);
}

export function run(ctx: Ctx): void {
  const player = ctx.player;
  if (!player) {
    for (const id of ALL) {
      skipped(ctx, id, 'no player connected (headless run) — there is no off-hand to write to');
    }
    return;
  }

  // Refuse to run over an occupied slot. On one earlier run the probe skipped itself because the
  // off-hand already held a custom item, and that skip was itself informative — but silently
  // overwriting whatever is there would destroy it.
  const occupied = offhandId(player);
  if (occupied) {
    ctx.say(`§eOff-hand already holds ${occupied}.§r Empty it and re-run, or this probe would destroy it.`);
    for (const id of ALL) skipped(ctx, id, `the off-hand already holds ${occupied} — refusing to overwrite it`);
    return;
  }

  const p = PARAMS.offhand;
  // Several chained settle delays, so this finishes many seconds after `run` returns. `done()`
  // waits for the release below rather than printing its marker over the top of these results.
  const reported = willReportLater('offhand');

  // ---------------------------------------------------------------------
  // 1. The control, first, because nothing below means anything without it.
  // ---------------------------------------------------------------------
  clearOffhand(player);
  place(player, p.permitted_item, (control) => {
    const controlHeld = control.after === p.permitted_item;
    result(
      ctx,
      CONTROL,
      !control.accepted ? 'INCONCLUSIVE' : controlHeld ? 'YES' : 'NO',
      { settle_ticks: p.settle_ticks, ...control },
      controlHeld
        ? 'the slot keeps an item it is supposed to keep — the apparatus writes and reads correctly'
        : 'AN ITEM THE OFF-HAND IS SUPPOSED TO ACCEPT DID NOT STAY. Every negative in this file ' +
          'is measuring this probe rather than Bedrock until that is explained.',
    );

    // ---------------------------------------------------------------------
    // 2 & 3. Acceptance and persistence, across the spread.
    // ---------------------------------------------------------------------
    clearOffhand(player);
    placeEach(player, p.arbitrary_items, (trials) => {
      const acceptedAll = trials.every((t) => t.accepted);
      const refused = trials.filter((t) => !t.accepted).map((t) => t.item);
      result(
        ctx,
        ACCEPTS,
        acceptedAll ? 'YES' : 'NO',
        { items: p.arbitrary_items, trials },
        acceptedAll
          ? `setEquipment succeeded for all ${trials.length} item(s) the slot would refuse by hand`
          : `the call itself was refused for ${refused.join(', ')}`,
      );

      const landed = trials.filter((t) => t.accepted && t.immediate);
      const stayed = landed.filter((t) => t.after === t.item);

      if (landed.length === 0) {
        result(
          ctx,
          PERSISTS,
          'INCONCLUSIVE',
          { trials },
          'no write landed at all, so there is nothing whose persistence could be measured — ' +
            'the apparatus, not the game',
        );
      } else {
        // YES only if EVERY item stayed. A partial allow-list is not "you can put arbitrary items
        // in the off-hand"; it is a different and more useful fact, and it goes in the evidence.
        const verdict = stayed.length === landed.length ? 'YES' : 'NO';
        result(
          ctx,
          PERSISTS,
          verdict,
          { settle_ticks: p.settle_ticks, trials, stayed: stayed.map((t) => t.item) },
          verdict === 'YES'
            ? `all ${landed.length} item(s) were still there after the settle delay — the off-hand ` +
              `renders arbitrary items for free`
            : stayed.length === 0
              ? `all ${landed.length} read back correctly and then vanished: the client ejects every ` +
                `item the slot would not accept by hand`
              : `${stayed.length} of ${landed.length} survived (${stayed.map((t) => t.item).join(', ')}) — ` +
                `the slot has a partial allow-list rather than a flat refusal, which is the more ` +
                `useful fact and the one a design should be built against`,
        );
      }

      // ---------------------------------------------------------------------
      // 4. Where an ejected item went. Only askable if something WAS ejected.
      // ---------------------------------------------------------------------
      const ejected = landed.filter((t) => t.after !== t.item);
      if (ejected.length === 0) {
        result(
          ctx,
          SURVIVES,
          'INCONCLUSIVE',
          { trials },
          'nothing was ejected, so nothing had to survive being ejected. Not a pass: this row is ' +
            'only meaningful while the persistence row is NO.',
        );
      } else {
        const lost = ejected.filter(
          (t) => (t.carriedAfter ?? 0) <= (t.carriedBefore ?? 0) && (t.floorAfter ?? 0) === 0,
        );
        result(
          ctx,
          SURVIVES,
          lost.length === 0 ? 'YES' : 'NO',
          { ejected },
          lost.length === 0
            ? `all ${ejected.length} ejected item(s) turned up again — in the inventory or on the ` +
              `floor. Writing to the off-hand is a failed effect, not a destructive one.`
            : `${lost.length} of ${ejected.length} ejected item(s) were nowhere afterwards ` +
              `(${lost.map((t) => t.item).join(', ')}). WRITING TO THE OFF-HAND CAN DESTROY AN ITEM.`,
        );
      }

      // ---------------------------------------------------------------------
      // 5. Our own item, which is what turns a flat "the off-hand is out" into
      //    something narrower.
      // ---------------------------------------------------------------------
      clearOffhand(player);
      place(player, IDS.offhand_custom, (custom) => {
        const persisted = custom.after === IDS.offhand_custom;
        result(
          ctx,
          CUSTOM,
          !custom.accepted ? 'INCONCLUSIVE' : persisted ? 'YES' : 'NO',
          { settle_ticks: p.settle_ticks, ...custom },
          persisted
            ? 'an item declaring allow_off_hand stays, so the limit is the item and not the slot'
            : 'even an item declaring allow_off_hand was ejected',
        );
        clearOffhand(player);
        reported();
      });
    });
  });
}
