/**
 * The probes whose entire job is to put something on a screen.
 *
 * None of these can report a verdict, and none of them try. A `LOOK` is not a result — the
 * runtime cannot even express one as a pass, because `emit.ts` gives it a different verb and
 * `run.ts` refuses to record it. The only path from these to the ledger runs through a person
 * in `bedshock amend`, answering from the enumerated outcomes the capability declares.
 *
 * What they owe the person looking is a scene that cannot be read two ways: every variant
 * labelled, every colour one that cannot be mistaken for another, and a control wherever there
 * is one to have.
 */

import { ItemStack, type Player } from '@minecraft/server';
import { ActionFormData } from '@minecraft/server-ui';

import { GLYPHS, IDS, PARAMS } from '../generated.ts';
import { look, skipped, type Ctx } from '../emit.ts';

function give(player: Player, stack: ItemStack): void {
  const inventory = player.getComponent('minecraft:inventory')?.container;
  if (inventory && inventory.emptySlotsCount > 0) inventory.addItem(stack);
  else player.dimension.spawnItem(stack, player.location);
}

/** The durability-bar ruler: 16 rows, 16 hues, at both ends of the bar's travel. */
export function ruler(ctx: Ctx): void {
  const rows = [
    'item.durability_bar.rows_covered',
    'item.durability_bar.track_appears_at_damage_one',
    'item.durability_bar.hotbar_matches_inventory_grid',
  ];
  if (!ctx.player) {
    for (const id of rows) skipped(ctx, id, 'no player connected (headless run)');
    return;
  }

  for (const damage of PARAMS.ruler.damage_samples) {
    const stack = new ItemStack(IDS.ruler, 1);
    const durability = stack.getComponent('minecraft:durability');
    if (durability) durability.damage = damage;
    // The value is READ BACK and stamped into the name, not merely written. If the write did
    // not take, the two copies are identical and the reading is void — and the names are the
    // only thing on screen that would say so.
    stack.nameTag = `P2 ruler · damage ${durability?.damage ?? '??'}/${PARAMS.ruler.max_durability}`;
    give(ctx.player, stack);
  }

  ctx.say('§7Row 15 is the BOTTOM row. Black notches mark rows 0, 4, 8, 12 — count from the bottom up.§r');
  look(ctx, rows[0]!, 'two ruler copies in your hotbar, at both ends of the bar. Which rows does the dark track cover?');
  look(ctx, rows[1]!, 'the nearly-pristine copy (damage 1). Is the dark track there at all?');
  look(ctx, rows[2]!, 'the same item in the hotbar and then in the inventory grid');
}

/** Coloured glyphs, in all three places a glyph can go. */
export function glyphs(ctx: Ctx): void {
  const rows = [
    'item.name.glyph_renders_in_colour',
    'item.name.glyph_alpha_is_honoured',
    'item.name.glyph_renders_in_item_name',
  ];
  if (!ctx.player) {
    for (const id of rows) skipped(ctx, id, 'no player connected (headless run)');
    return;
  }

  const all = GLYPHS.join(' ');
  // All three surfaces, because a glyph that works in chat and not on an item would be a trap:
  // the design reads as proven and fails exactly where it is needed.
  ctx.player.sendMessage(`chat: ${all}`);
  ctx.player.onScreenDisplay.setActionBar(`actionbar: ${all}`);
  const stack = new ItemStack(IDS.glyph, 1);
  stack.nameTag = `name: ${all}`;
  give(ctx.player, stack);

  ctx.say(`§7Authored colours, in order: ${PARAMS.glyphs.swatches.join(' ')}. Each is a RING on transparency.§r`);
  look(ctx, rows[0]!, 'four rings in chat. Are they in their own colours, or flattened?');
  look(ctx, rows[1]!, 'the centres of those rings. Do they read as background?');
  look(ctx, rows[2]!, 'the same four in the item name and the actionbar. Do all three agree?');
}

/** Two flipbook spellings, side by side. */
export function flipbook(ctx: Ctx): void {
  if (!ctx.player) {
    skipped(ctx, 'item.icon.animates_from_flipbook', 'no player connected (headless run)');
    return;
  }
  IDS.flipbook.forEach((id, i) => {
    const stack = new ItemStack(id, 1);
    stack.nameTag = `P10 spelling ${i + 1} — ${i === 0 ? 'explicit frames, blend off' : 'no frames, blend on'}`;
    give(ctx.player!, stack);
  });
  ctx.say(
    `§7${PARAMS.flipbook.frames} frames at ${PARAMS.flipbook.ticks_per_frame} ticks each. ` +
      'Two spellings, different in every field that could plausibly be the mistake — one cycling ' +
      'and one frozen means the spelling was the bug, not the engine.§r',
  );
  look(ctx, 'item.icon.animates_from_flipbook', 'the two flipbook items in your hotbar. Does either cycle?');
}

/** Four form buttons, four kinds of reference, one screen. */
export function formIcons(ctx: Ctx): void {
  const rows = [
    'ui.form.button_icon_resolves_an_unindexed_path',
    'ui.form.button_icon_resolves_a_bare_atlas_key',
    'ui.form.missing_icon_is_visually_distinct',
  ];
  if (!ctx.player) {
    for (const id of rows) skipped(ctx, id, 'no player connected (headless run) — a form needs somebody to show it to');
    return;
  }

  const icons = PARAMS.form_icons;
  const form = new ActionFormData()
    .title('P6 — what does an icon path resolve?')
    .body(
      'Button 2 is the CONTROL: a vanilla path. If it does not draw, the mechanism is broken and ' +
        'nothing else on this screen means anything.',
    )
    .button('1 · ours, deliberately NOT in the atlas', icons.unindexed_path)
    .button('2 · vanilla — the control', icons.vanilla_path)
    .button('3 · a bare atlas key, not a path', icons.atlas_key)
    .button('4 · a deliberate miss', icons.missing_path);

  form.show(ctx.player).catch(() => {
    /* dismissed; the scene was the point */
  });

  look(ctx, rows[0]!, 'button 1 in the form now open, against button 2 (vanilla control)');
  look(ctx, rows[1]!, 'button 3 — a bare atlas short-name where a path is expected');
  look(ctx, rows[2]!, 'button 4 — is a wrong path visually distinct from no icon at all?');
}
