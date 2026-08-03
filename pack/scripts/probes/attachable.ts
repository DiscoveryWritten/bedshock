/**
 * Can a custom item render a model in the hand, and can that model read the item's damage?
 *
 * THE LARGEST SINGLE CONSEQUENCE IN THIS BATTERY. If a render controller can read
 * `query.remaining_durability` off the item it is drawing, ONE item type renders every
 * configuration a mod can encode. If it cannot, the item looks identical in every configuration
 * and its state has to live somewhere else entirely — which is a design constraint an add-on has
 * to be built around rather than patched for.
 *
 * THREE RIGS, IN DEPENDENCY ORDER, AND THE ORDER IS THE POINT.
 *
 *   1. THE FLOOR (`attach_min`). One geometry, one texture, one controller, no Molang. Does a
 *      custom item render an attachable AT ALL? A dark candidate rig cannot say whether the
 *      queries are blind or whether attachables simply do not work here, so until this is YES
 *      nothing above it is readable.
 *   2. THE CANDIDATES (`attach_a` / `attach_b`). Four flags, four Molang expressions, one palette.
 *   3. THE POSE (`att_pose`). The floor's cube plus the vanilla hold animations, so whatever moves
 *      between them is the animation binding and nothing else.
 *
 * THE CANDIDATE READING IS DIFFERENTIAL, AND IT HAS TO BE. Two items identical but for damage;
 * hold each in turn. A live query MUST change colour between them and a blind one cannot. An
 * absolute reading of one item is structurally ambiguous — see the note in `content/pack.yaml`,
 * where the arithmetic is worked out and `bedshock validate` reproduces it.
 *
 * EVERY ROW HERE IS EYES-ONLY. Nothing in the script API can see what a render controller drew,
 * which is exactly why the rig has a control flag wired to a literal: when the picture is wrong
 * and every link checks out, the only thing that saves the session is knowing the rig itself works.
 */

import { ItemStack, type Player } from '@minecraft/server';

import { IDS, PARAMS } from '../generated.ts';
import { look, skipped, type Ctx } from '../emit.ts';

const PALETTE = ['RED', 'GREEN', 'BLUE', 'WHITE'];

const CANDIDATE_ROWS = [
  'render.attachable.draws_on_custom_item',
  'render.attachable.anchor_is_on_the_body',
  'render.attachable.reads_held_item_durability',
  'render.attachable.several_controllers_at_once',
];

function give(player: Player, stack: ItemStack): void {
  const inventory = player.getComponent('minecraft:inventory')?.container;
  if (inventory && inventory.emptySlotsCount > 0) inventory.addItem(stack);
  else player.dimension.spawnItem(stack, player.location);
}

/**
 * What each candidate should draw at a given damage, computed HERE rather than restated.
 *
 * The same arithmetic the Molang does, so the instruction on screen cannot drift from what the
 * rig will actually show. A person reading "expect WHITE" off a screen and seeing WHITE has
 * confirmed something; a person reading a hand-typed colour has confirmed that somebody typed it.
 */
function expected(damage: number): string[] {
  const max = PARAMS.attachable.max_durability;
  const index: Record<string, number> = {
    remaining: (max - damage) % PALETTE.length,
    damage: damage % PALETTE.length,
    use_duration: 0,
    control: 2,
  };
  return PARAMS.attachable.candidates.map((c) => PALETTE[index[c.id] ?? 0] ?? '??');
}

/** The floor, the candidates and the two-item differential. */
export function run(ctx: Ctx): void {
  if (!ctx.player) {
    for (const id of CANDIDATE_ROWS) skipped(ctx, id, 'no player connected (headless run)');
    return;
  }

  give(ctx.player, new ItemStack(IDS.attach_min, 1));

  // The two candidate items, damage READ BACK and stamped into the name rather than merely
  // written. If the write did not take, the two copies are identical, the differential is void,
  // and the names are the only thing on screen that would say so.
  const damages = [PARAMS.attachable.damage, PARAMS.attachable.damage_b];
  IDS.attach.forEach((id, i) => {
    const stack = new ItemStack(id, 1);
    const durability = stack.getComponent('minecraft:durability');
    if (durability) durability.damage = damages[i]!;
    stack.nameTag = `P3b ${i === 0 ? 'A' : 'B'} · damage ${durability?.damage ?? '??'}`;
    give(ctx.player!, stack);
  });

  ctx.say('§7Flags run LEFT TO RIGHT in candidate order:§r');
  PARAMS.attachable.candidates.forEach((candidate, i) => {
    ctx.say(`§7  ${i} ${candidate.id} — ${candidate.note}§r`);
  });
  ctx.say(`§7Expected at damage ${damages[0]}: ${expected(damages[0]!).join(' ')}§r`);
  ctx.say(`§7Expected at damage ${damages[1]}: ${expected(damages[1]!).join(' ')}§r`);
  ctx.say('§7The last flag is the CONTROL, wired to a literal. If it is not BLUE, nothing else means anything.§r');

  look(ctx, CANDIDATE_ROWS[0]!, 'the minimal probe (P3a) in your hand. A plain magenta cube, or nothing at all?');
  look(
    ctx,
    CANDIDATE_ROWS[1]!,
    'where that cube sits relative to your body, in FIRST and THIRD person. On the hand, or on the body?',
  );
  look(
    ctx,
    CANDIDATE_ROWS[2]!,
    `hold A then B and compare the four flags. Any flag that CHANGES is a live query; all four ` +
      `identical across both items means every query is blind`,
  );
  look(ctx, CANDIDATE_ROWS[3]!, 'how many of the four flags drew at once, and whether they z-fight or reorder');
}

/**
 * The hold pose, which is a different question from whether anything renders.
 *
 * Its own probe rather than a fifth `look` on the rig above, because it needs a different item in
 * the hand and because its answer is worth having even when the durability queries are dead — a
 * hand-posed attachable can only ever show one fixed look, which is worth something for flavour
 * and nothing for information.
 */
export function pose(ctx: Ctx): void {
  const row = 'render.attachable.accepts_vanilla_hold_animations';
  if (!ctx.player) {
    skipped(ctx, row, 'no player connected (headless run)');
    return;
  }

  give(ctx.player, new ItemStack(IDS.attach_pose, 1));
  ctx.say(
    '§7The CYAN cube declares the vanilla hold animations. The MAGENTA one (P3a) declares none ' +
      'and is its control — whatever differs between them is the animation binding.§r',
  );
  look(
    ctx,
    row,
    'the cyan cube against the magenta one, in first AND third person. Is the cyan one posed into ' +
      'the hand, or does it sit where the unposed one does?',
  );
}
