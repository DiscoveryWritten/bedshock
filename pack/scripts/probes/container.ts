/**
 * Can a custom entity carry a container a player can open?
 *
 * The only route Bedrock has to a real item slot — somewhere any item can be dropped, modded
 * ones included, with the game drawing its sprite for you. That is the one thing the scripting
 * UI fundamentally cannot provide.
 *
 * Storage via `minecraft:inventory` is documented and its knobs are known. What is NOT
 * documented is how a fully custom entity gets its container OPENED, because on Bedrock that is
 * welded to chest-boat and horse machinery rather than exposed as a component. So the variants
 * are a best guess by construction, and a negative result means "this recipe does not work",
 * NOT "custom containers are impossible" — reading it as the latter closes off the only route
 * there is.
 *
 * THE AUTOMATED HALF AND THE OBSERVED HALF ARE NOT THE SAME QUESTION, and conflating them
 * would overstate the finding badly. `container.size` is the storage. The screen is a fixed
 * vanilla layout that may draw a different number of cells, or none, or refuse to open at all.
 * Script sees the first; only a player sees the second.
 */

import { ItemStack, world, type Entity } from '@minecraft/server';

import { IDS } from '../generated.ts';
import { firstLine, result, look, skipped, HEADLESS_AT, type Ctx } from '../emit.ts';

const SPAWNED = 'bedshock:container_probe_ids';

interface Sample {
  id: string;
  container_type: string;
  declared: number;
  spawned: boolean;
  reported?: number;
  writable?: boolean;
  error?: string;
}

export function run(ctx: Ctx): void {
  const at = ctx.player?.location ?? HEADLESS_AT;
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');
  const spawned: Entity[] = [];
  const samples: Sample[] = [];

  IDS.containers.forEach((variant, i) => {
    const sample: Sample = {
      id: variant.id,
      container_type: variant.container_type,
      declared: variant.size,
      spawned: false,
    };
    try {
      const entity = dimension.spawnEntity(variant.id, {
        x: at.x + (i - IDS.containers.length / 2) * 2,
        y: at.y,
        z: at.z + 2,
      });
      entity.nameTag = `${variant.container_type} x${variant.size}`;
      sample.spawned = true;
      spawned.push(entity);

      const container = entity.getComponent('minecraft:inventory')?.container;
      if (container) {
        sample.reported = container.size;
        // A diamond in slot 0 does double duty: it proves script can write, and it is what a
        // player looks for when answering whether the screen shows what script stored.
        container.setItem(0, new ItemStack('minecraft:diamond', 1));
        sample.writable = container.getItem(0)?.typeId === 'minecraft:diamond';
      }
    } catch (err) {
      sample.error = firstLine(err);
    }
    samples.push(sample);
  });

  world.setDynamicProperty(SPAWNED, JSON.stringify(spawned.map((e) => e.id)));

  const withContainers = samples.filter((s) => s.spawned && s.reported !== undefined);
  const allWritable = withContainers.length > 0 && withContainers.every((s) => s.writable);
  result(
    ctx,
    'entity.container.storage_via_inventory_component',
    withContainers.length === 0 ? 'INCONCLUSIVE' : allWritable ? 'YES' : 'NO',
    { samples },
    withContainers.length === 0
      ? 'no variant spawned with a readable container — check for LocationInUnloadedChunkError, ' +
        'which measures the instrument rather than the game'
      : `${withContainers.length}/${samples.length} variants carry a container script can read and write`,
  );

  const honoured = withContainers.filter((s) => s.reported === s.declared);
  result(
    ctx,
    'entity.container.api_honours_declared_inventory_size',
    withContainers.length === 0 ? 'INCONCLUSIVE' : honoured.length === withContainers.length ? 'YES' : 'NO',
    { samples: withContainers },
    `${honoured.length}/${withContainers.length} report the size they declared — note this is what ` +
      'the API sees, and says nothing about what the screen draws',
  );

  if (!ctx.player) {
    for (const id of [
      'entity.container.opens_with_container_type_horse',
      'entity.container.opens_with_container_type_chest',
      'entity.container.screen_draws_declared_slot_count',
      'entity.container.slots_are_untyped',
      'entity.container.script_writes_appear_in_screen',
      'entity.container.preview_panel_renders_the_entity',
    ]) {
      skipped(ctx, id, 'no player connected (headless run) — opening a container needs hands');
    }
    return;
  }

  const named = samples.filter((s) => s.spawned).map((s) => `${s.container_type} x${s.declared}`).join(', ');
  look(ctx, 'entity.container.opens_with_container_type_horse', `spawned in front of you: ${named}. Interact with the horse-type one`);
  look(ctx, 'entity.container.opens_with_container_type_chest', 'interact with the chest-type one — same components, only container_type differs');
  look(ctx, 'entity.container.screen_draws_declared_slot_count', 'open each horse variant and COUNT the cells drawn, against what it declared');
  look(ctx, 'entity.container.slots_are_untyped', 'try moving the diamond between slots, and putting something else in');
  look(ctx, 'entity.container.script_writes_appear_in_screen', 'script put a diamond in slot 0 of every one — is it in the screen?');
  look(ctx, 'entity.container.preview_panel_renders_the_entity', 'the left panel of the open screen. Move the cursor across it');
  ctx.say('§7When you are done: `/scriptevent bedshock:probe container.clear`§r');
}

/** `/scriptevent bedshock:probe container.clear` */
export function clear(ctx: Ctx): void {
  const raw = world.getDynamicProperty(SPAWNED);
  const ids = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : [];
  let removed = 0;
  for (const id of ids) {
    const entity = world.getEntity(id);
    if (entity) {
      entity.remove();
      removed++;
    }
  }
  world.setDynamicProperty(SPAWNED, undefined);
  ctx.say(`removed ${removed} container probe entit${removed === 1 ? 'y' : 'ies'}.`);
}
