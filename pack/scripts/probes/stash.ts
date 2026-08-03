/**
 * Storing an ItemStack by MOVING it, and whether the thing you moved it into can be found again.
 *
 * WHY THIS ROUTE EXISTS AT ALL. Any storage that takes an item apart into data and rebuilds it
 * must refuse shulker boxes, written books, potions, fireworks, maps and banners — handing one
 * back would hand back an empty one, and the script API cannot read their contents to know it did.
 * Moving the real stack into a holder entity's container removes the whole class of problem,
 * because nothing is ever read or reconstructed.
 *
 * WHAT DECIDES THE DESIGN IS NOT WHETHER IT SURVIVES, BUT WHETHER THE HOLDER IS FINDABLE.
 * If `world.getEntity(id)` still resolves after the holder's chunk has unloaded, storage can be a
 * holder PER ITEM — small, local, no world fixtures. If it only resolves while loaded, it has to
 * be a VAULT: one holder in a permanently ticking area at a fixed location, with everything that
 * implies. Those are different mods.
 *
 * THE SESSION TOKEN IS WHAT MAKES THE RELOAD ROW ANSWERABLE. A counter bumped from `worldLoad`
 * goes up exactly once per load by definition, so "these two readings came from different
 * sessions" is true by construction — nothing to remember, nothing to set, nothing a person can
 * accidentally get wrong. The fetch compares the token in the stash record against the current one
 * and says outright whether a reload happened. Without it, a stash and fetch done in one sitting
 * produces a confident YES to a question nobody asked.
 *
 * AND A SAME-SESSION FETCH DOES NOT SPEND THE STASH. Handing the item back would consume the one
 * setup that can answer the reload row, and the person would have to notice that themselves.
 */

import { system, world, type Entity, type Player } from '@minecraft/server';

import { IDS } from '../generated.ts';
import { look, skipped, type Ctx } from '../emit.ts';

const RECORD = 'bedshock:stash';
const LOADS = 'bedshock:world_loads';

/**
 * A number that goes up once per world load, and that is the entire mechanism.
 *
 * NOT `Date.now()`, which is what this was first written as. A clock reads the same twice if two
 * calls land in the same millisecond and — much worse — makes the probe depend on `Date` existing
 * in Bedrock's script engine, at MODULE SCOPE, where a throw takes the whole pack down rather than
 * one probe. A counter bumped from `worldLoad` cannot do either: the event fires once per load by
 * definition, so "these two readings are from different sessions" is true by construction rather
 * than by argument.
 *
 * Read at module scope, incremented on load. Anything that reads `session()` before the first load
 * event gets the previous world's number, which is correct: no load has happened yet.
 */
let loads = 0;

world.afterEvents.worldLoad.subscribe(() => {
  const raw = world.getDynamicProperty(LOADS);
  loads = (typeof raw === 'number' ? raw : 0) + 1;
  world.setDynamicProperty(LOADS, loads);
});

const session = (): string => `load-${loads}`;

const ROWS = {
  preserves: 'entity.stash.preserves_an_opaque_itemstack',
  chunk: 'entity.stash.holder_findable_after_chunk_unload',
  reload: 'entity.stash.holder_findable_after_world_reload',
} as const;

interface StashRecord {
  holder: string;
  at: { x: number; y: number; z: number };
  session: string;
  what: string;
}

function readRecord(): StashRecord | undefined {
  const raw = world.getDynamicProperty(RECORD);
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as StashRecord;
  } catch {
    return undefined;
  }
}

/**
 * Put what the player is holding into a holder entity, and remember where it went.
 *
 * The holder is a container variant this pack already ships, deliberately: a bespoke entity built
 * for this would make "the stash worked" and "this particular entity works" the same sentence, and
 * the container rows have already established that this one stores things.
 */
export function run(ctx: Ctx): void {
  const player = ctx.player;
  if (!player) {
    for (const id of Object.values(ROWS)) skipped(ctx, id, 'no player connected (headless run)');
    return;
  }

  const inventory = player.getComponent('minecraft:inventory')?.container;
  const held = inventory?.getItem(player.selectedSlotIndex);
  if (!inventory || !held) {
    // NOT a negative. An empty hand is a protocol failure, and filing it as a NO would put
    // "nothing came back" in the ledger for a run where nothing was ever put in.
    for (const id of Object.values(ROWS)) {
      skipped(ctx, id, 'nothing in the main hand to stash');
    }
    ctx.say(
      `§eHold something first — ideally a ${IDS.stash_carrier} YOU HAVE PUT THINGS IN. Its ` +
        `contents are state the script API cannot read, which is the whole reason this route ` +
        `exists; anything else is a weaker witness.§r`,
    );
    return;
  }

  let holder: Entity;
  try {
    holder = player.dimension.spawnEntity(IDS.stash_holder, player.location);
  } catch (err) {
    for (const id of Object.values(ROWS)) skipped(ctx, id, `the holder entity would not spawn: ${String(err).split('\n')[0]}`);
    return;
  }

  const holderContainer = holder.getComponent('minecraft:inventory')?.container;
  if (!holderContainer) {
    holder.remove();
    for (const id of Object.values(ROWS)) skipped(ctx, id, 'the holder spawned with no inventory component');
    return;
  }

  holderContainer.addItem(held);
  inventory.setItem(player.selectedSlotIndex, undefined);

  const at = {
    x: Math.round(holder.location.x),
    y: Math.round(holder.location.y),
    z: Math.round(holder.location.z),
  };
  const record: StashRecord = { holder: holder.id, at, session: session(), what: held.typeId };
  world.setDynamicProperty(RECORD, JSON.stringify(record));

  ctx.say(`§astashed §r${held.typeId}§a into holder §7${holder.id}§a at §7${at.x}, ${at.y}, ${at.z}§r`);
  ctx.say(
    '§7Now do ONE of these and run §f/scriptevent bedshock:probe stash.fetch§7:\n' +
      '  · fetch straight away — answers whether the move works at all\n' +
      '  · walk far enough that the chunk unloads, come back, fetch\n' +
      '  · QUIT TO TITLE, reload, fetch — not just back to the world list§r',
  );
  ctx.say(`§7Those coordinates matter: if the fetch fails, walk back to them and try again. "Gone forever" and "findable only while loaded" point at different designs.§r`);
}

/** The other half, and the half that reports. */
export function fetch(ctx: Ctx): void {
  const player = ctx.player;
  if (!player) {
    for (const id of Object.values(ROWS)) skipped(ctx, id, 'no player connected (headless run)');
    return;
  }

  const record = readRecord();
  if (!record) {
    for (const id of Object.values(ROWS)) skipped(ctx, id, 'nothing has been stashed yet');
    ctx.say('§eNothing stashed. Run §f/scriptevent bedshock:probe stash§e first.§r');
    return;
  }

  const reloaded = record.session !== session();
  const holder = world.getEntity(record.holder);

  ctx.say(
    `§7stash: §r${record.what}§7 in holder §r${record.holder}§7 at §r${record.at.x}, ${record.at.y}, ` +
      `${record.at.z}§r`,
  );
  // Said outright rather than left to be inferred. A run made in one sitting cannot be mistaken
  // for the one that answers the reload question if the readout names which it was.
  ctx.say(
    reloaded
      ? '§aTHE WORLD HAS RELOADED since this was stashed.§r'
      : '§eSAME SESSION — no reload has happened. The reload row cannot be answered by this fetch.§r',
  );

  if (!holder) {
    ctx.say(`§cworld.getEntity could not find the holder.§r Walk to ${record.at.x}, ${record.at.y}, ${record.at.z} and run this again.`);
    look(ctx, ROWS.chunk, 'whether the fetch works from here, or only after walking back to the printed coordinates');
    if (reloaded) look(ctx, ROWS.reload, 'the line above: the holder could not be found after a reload');
    else skipped(ctx, ROWS.reload, 'no reload happened between stash and fetch');
    skipped(ctx, ROWS.preserves, 'the holder could not be found, so nothing could be handed back');
    return;
  }

  const holderContainer = holder.getComponent('minecraft:inventory')?.container;
  const stored = holderContainer?.getItem(0);

  if (!reloaded) {
    // DELIBERATELY DOES NOT SPEND THE STASH. Handing the item back here would consume the one
    // setup that can answer the reload row, and nothing would say so.
    ctx.say(
      stored
        ? `§athe holder is findable and still carries §r${stored.typeId}§a.§r Left in place — quit to title and fetch again for the reload row.`
        : '§cthe holder is findable but its container is empty.§r',
    );
    look(ctx, ROWS.chunk, 'whether the fetch worked from where you were standing, or only next to the holder');
    skipped(ctx, ROWS.reload, 'no reload happened between stash and fetch');
    skipped(ctx, ROWS.preserves, 'the item was left in place so the reload row stays answerable — fetch after a reload to spend it');
    return;
  }

  if (!stored) {
    ctx.say('§cthe holder survived the reload but its container is empty.§r');
    look(ctx, ROWS.preserves, 'the line above: the holder came back and the item did not');
    look(ctx, ROWS.reload, 'the holder was findable after the reload');
    look(ctx, ROWS.chunk, 'whether the fetch worked from where you were standing');
    return;
  }

  const inventory = player.getComponent('minecraft:inventory')?.container;
  if (inventory && inventory.emptySlotsCount > 0) inventory.addItem(stored);
  else player.dimension.spawnItem(stored, player.location);
  holderContainer?.setItem(0, undefined);
  system.run(() => holder.remove());
  world.setDynamicProperty(RECORD, undefined);

  ctx.say(`§areturned §r${stored.typeId}§a after a reload.§r`);
  look(
    ctx,
    ROWS.preserves,
    `the returned ${stored.typeId}. PLACE IT AND OPEN IT — whether its contents survived is the ` +
      `question, and it is the one thing script cannot check for you`,
  );
  look(ctx, ROWS.reload, 'the holder was findable by id after a full quit to title');
  look(ctx, ROWS.chunk, 'whether the fetch worked from where you were standing, or only next to the holder');
}
