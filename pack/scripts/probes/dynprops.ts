/**
 * Do an ItemStack's dynamic properties survive a round trip?
 *
 * THREE DIFFERENT QUESTIONS, and only the first can be answered synchronously.
 *
 *   ROUND TRIP   set a property, put the stack in a container, take it back out, read it.
 *                Automated, headless, instant.
 *   DROP/PICKUP  survives the item existing in the world as an entity. Needs hands.
 *   RELOAD       survives the world being closed and reopened. Needs the passage of time,
 *                which a battery cannot perform.
 *
 * THE SESSION TOKEN, and why the last two are not just "run it, then run it again".
 *
 * A probe with two halves and no memory reports the same PASS whether or not the thing between
 * them actually happened. A run made in one sitting is then indistinguishable from the run that
 * answers the question — which is a defect in the instrument, not in the report, and it is the
 * kind that produces a confident answer to a question nobody asked.
 *
 * So the stamp carries a token computed at MODULE SCOPE. Script modules are re-evaluated on
 * every world load, so that value is new each session by construction — nothing has to
 * remember to change it. The follow-up compares, and says outright whether a reload happened.
 * The protocol is enforced rather than described.
 */

import { ItemStack, world, type Player } from '@minecraft/server';

import { IDS } from '../generated.ts';
import { firstLine, result, look, skipped, HEADLESS_AT, type Ctx } from '../emit.ts';

/**
 * New on every world load, by construction rather than by discipline.
 *
 * Deliberately not a timestamp: two loads within the same second would collide, and the one
 * time that matters is a quick quit-and-reload.
 */
const SESSION = `s${Math.floor(Math.random() * 1e9).toString(36)}`;

const KEY = 'bedshock:token';
const STAMP_RECORD = 'bedshock:dynprop_stamp';

function stamped(token: string): ItemStack {
  const stack = new ItemStack(IDS.dynprop, 1);
  stack.setDynamicProperty(KEY, token);
  stack.nameTag = `P8 carrier ${token}`;
  return stack;
}

/** The automated half: does the property survive `setItem` then `getItem`? */
export function run(ctx: Ctx): void {
  const token = `${SESSION}-${Math.floor(Math.random() * 1e6)}`;

  let survived: boolean;
  let readBack: unknown;
  try {
    // Round trip through one of OUR container entities rather than a vanilla stand.
    //
    // The first server run used `minecraft:armor_stand` and reported INCONCLUSIVE with "no
    // container to round trip through" -- an armor stand carries equipment slots, not a
    // `minecraft:inventory`, so there was nothing to put an item into. A probe measuring its
    // own choice of prop rather than the game, which is the failure this battery exists to
    // catch and is no less embarrassing for being caught by itself.
    //
    // The probe entities are known-good by construction: the container probe verifies in the
    // same run that they spawn and that script can read and write their slots. If that row is
    // not YES, this one has no business reporting anything either.
    const holderId = IDS.containers[0]?.id;
    if (!holderId) {
      result(ctx, 'item.dynamic_properties.survive_get_set_round_trip', 'INCONCLUSIVE', undefined,
        'no probe container entity is declared to round trip through');
      return;
    }
    const holder = world.getDimension('overworld').spawnEntity(holderId, HEADLESS_AT);
    const container = holder.getComponent('minecraft:inventory')?.container;
    if (!container) {
      result(ctx, 'item.dynamic_properties.survive_get_set_round_trip', 'INCONCLUSIVE', undefined,
        `${holderId} spawned but carries no container — the apparatus failed, not the game. ` +
          'Check entity.container.storage_via_inventory_component in this same run.');
      holder.remove();
      return;
    }
    container.setItem(0, stamped(token));
    readBack = container.getItem(0)?.getDynamicProperty(KEY);
    survived = readBack === token;
    holder.remove();
  } catch (err) {
    result(ctx, 'item.dynamic_properties.survive_get_set_round_trip', 'INCONCLUSIVE', undefined,
      `could not run the round trip: ${firstLine(err)}`);
    return;
  }

  result(
    ctx,
    'item.dynamic_properties.survive_get_set_round_trip',
    survived ? 'YES' : 'NO',
    { wrote: token, read: readBack ?? null },
    survived
      ? 'mutate-in-place is safe: a state toggle need never swap item types'
      : 'the property did not come back — anything storing state this way loses it on every write',
  );

  // The two halves that need a world rather than a script. Setting the scene is all this can
  // do; the verdict belongs to whoever looks.
  if (!ctx.player) {
    skipped(ctx, 'item.dynamic_properties.survive_drop_and_pickup', 'no player connected (headless run)');
    skipped(ctx, 'item.dynamic_properties.survive_world_reload', 'no player connected (headless run)');
    return;
  }
  stamp(ctx, ctx.player);
}

/** `/scriptevent bedshock:probe dynprops.stamp` — set up both eyes-only halves at once. */
export function stamp(ctx: Ctx, player: Player): void {
  const token = `${SESSION}-${Math.floor(Math.random() * 1e6)}`;
  world.setDynamicProperty(STAMP_RECORD, JSON.stringify({ token, session: SESSION, at: Date.now() }));

  const inventory = player.getComponent('minecraft:inventory')?.container;
  const carrier = stamped(token);
  if (inventory && inventory.emptySlotsCount > 0) inventory.addItem(carrier);
  else player.dimension.spawnItem(carrier, player.location);

  // Dropped deliberately rather than handed over: the drop is the measurement.
  player.dimension.spawnItem(stamped(token), player.location);

  look(
    ctx,
    'item.dynamic_properties.survive_drop_and_pickup',
    `dropped a carrier stamped "${token}" at your feet. Pick it up, then run ` +
      `/scriptevent bedshock:probe dynprops.token`,
  );
  look(
    ctx,
    'item.dynamic_properties.survive_world_reload',
    `stamped "${token}" (session ${SESSION}). QUIT TO TITLE, reload, then run ` +
      `/scriptevent bedshock:probe dynprops.token — it will say whether a reload actually happened`,
  );
}

/** `/scriptevent bedshock:probe dynprops.token` — read the stamp back. */
export function token(ctx: Ctx, player: Player): void {
  const raw = world.getDynamicProperty(STAMP_RECORD);
  if (typeof raw !== 'string') {
    ctx.say('§cNo stamp recorded.§r Run `/scriptevent bedshock:probe dynprops.stamp` first.');
    return;
  }
  const record = JSON.parse(raw) as { token: string; session: string };
  const reloaded = record.session !== SESSION;

  const inventory = player.getComponent('minecraft:inventory')?.container;
  let found: string | undefined;
  for (let slot = 0; inventory && slot < inventory.size; slot++) {
    const item = inventory.getItem(slot);
    if (item?.typeId !== IDS.dynprop) continue;
    const value = item.getDynamicProperty(KEY);
    if (typeof value === 'string') found = value;
  }

  ctx.say(
    `stamp §e${record.token}§r · carrier in your bag: §e${found ?? 'none'}§r · ` +
      `reload since stamping: ${reloaded ? '§aYES§r' : '§cNO — same session§r'}`,
  );

  if (!reloaded) {
    ctx.say(
      '§7The drop/pickup half is answerable now. The reload half is NOT — a same-session read ' +
        'cannot tell you anything about a reload, and recording one would be recording the ' +
        'instrument.§r',
    );
  }
  ctx.say(
    found === record.token
      ? '§aThe property came back.§r Record it against whichever half you actually performed.'
      : '§cThe property did not come back.§r',
  );
}
