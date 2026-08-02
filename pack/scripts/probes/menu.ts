/**
 * Can items be kept out of the creative menu, and can they be grouped?
 *
 * THE EXISTENCE CHECK IS THE POINT OF RUNNING THIS HEADLESS, and it is easy to skip.
 *
 * A rejected item definition is invisible on Bedrock. So is a successfully hidden one. Reading
 * a rejection as successful hiding would be an expensive mistake to build on — a generator
 * would go on emitting a `menu_category` the game throws out, and the menu would look exactly
 * as intended. Confirming every variant EXISTS before anyone looks at a picker is what makes
 * the visibility reading mean anything at all.
 *
 * Only the existence half is measurable from script. Whether the menu then hides or nests them
 * is four separate observed rows.
 */

import { ItemStack } from '@minecraft/server';

import { IDS } from '../generated.ts';
import { firstLine, result, look, skipped, type Ctx } from '../emit.ts';

export function run(ctx: Ctx): void {
  const samples = IDS.menu.map((variant) => {
    try {
      new ItemStack(variant.id, 1);
      return { id: variant.id, label: variant.label, exists: true };
    } catch (err) {
      return { id: variant.id, label: variant.label, exists: false, error: firstLine(err) };
    }
  });

  const grouped = samples.filter((s) => IDS.menu.find((v) => v.id === s.id)?.group);
  const allExist = samples.every((s) => s.exists);
  const groupedExist = grouped.length > 0 && grouped.every((s) => s.exists);

  result(
    ctx,
    'item.creative.custom_group_is_accepted',
    groupedExist ? 'YES' : 'NO',
    { samples },
    groupedExist
      ? `all ${grouped.length} variants carrying a custom group string exist as real items — ` +
        'whatever the menu does with them is hiding or showing, never rejecting'
      : 'a custom group string got the definition rejected, so any visibility reading below is about a rejection',
  );

  if (!allExist) {
    ctx.say('§eSome menu variants do not exist.§r The visibility rows below cannot be read until they do.');
  }

  const eyes = [
    'item.creative.hidden_by_omitting_category',
    'item.creative.hidden_by_category_none',
    'item.creative.custom_group_nests_items',
    'item.creative.order_follows_emission',
  ];
  if (!ctx.player) {
    for (const id of eyes) skipped(ctx, id, 'no player connected (headless run) — there is no creative menu to read');
    return;
  }
  for (const id of eyes) {
    look(ctx, id, `open the creative menu and search "P7". ${samples.length} variants are emitted, each labelled with what it is`);
  }
}
