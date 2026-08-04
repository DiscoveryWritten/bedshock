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

import { IDS, PARAMS } from '../generated.ts';
import { firstLine, result, look, skipped, HEADLESS_AT, type Ctx } from '../emit.ts';

const SPAWNED = 'bedshock:container_probe_ids';

interface Sample {
  id: string;
  container_type: string;
  declared: number;
  spawned: boolean;
  reported?: number;
  writable?: boolean;
  /** How many slots the discovery pass filled with a marker. */
  filled?: number;
  error?: string;
}

/**
 * Candidate rules for how a declared inventory size becomes a number of reachable slots.
 *
 * NONE OF THESE IS A THEORY OF BEDROCK. They are the shapes worth ruling out, and the probe
 * reports which ones are still standing after every variant rather than picking one. With a
 * handful of sizes several will survive, and saying "three rules still fit" is the honest
 * output — a probe that named a single winner from four data points would be inventing one.
 *
 * The sizes in `content/pack.yaml` are chosen to be where these disagree: `declared - 2` and
 * `floor(declared / 3) * 3` agree at 1 and 5, which is exactly the pair an informal session
 * happened to try, and disagree at 3, 4 and 6.
 */
const RULES: { name: string; of: (declared: number) => number }[] = [
  { name: 'reachable = declared', of: (d) => d },
  { name: 'reachable = declared floored to a multiple of 3', of: (d) => Math.floor(d / 3) * 3 },
  { name: 'reachable = declared - 2, never below zero', of: (d) => Math.max(0, d - 2) },
  { name: 'reachable = declared capped at 15, the vanilla horse chest', of: (d) => Math.min(d, 15) },
  { name: 'reachable = 0 — the screen draws no usable slots at all', of: () => 0 },
];

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
        // EVERY slot gets a marker, not just the first. Slot 0 proves script can write and is
        // what a player looks for when answering whether the screen shows what script stored --
        // but the rest are the discovery pass: a person empties the container by hand and the
        // script reads back which slots went empty. That is how many slots they could REACH,
        // measured rather than counted, with nobody typing a number.
        for (let slot = 0; slot < container.size; slot++) {
          container.setItem(slot, new ItemStack(PARAMS.container_marker, 1));
        }
        sample.writable = container.getItem(0)?.typeId === PARAMS.container_marker;
        sample.filled = container.size;
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
      'entity.container.reachable_slots_match_declared_size',
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
  look(ctx, 'entity.container.script_writes_appear_in_screen', `script filled every slot with ${PARAMS.container_marker} — is it in the screen?`);
  look(ctx, 'entity.container.preview_panel_renders_the_entity', 'the left panel of the open screen. Move the cursor across it');
  ctx.say(
    `§b§lTHE DISCOVERY PASS.§r Open each of the ${spawned.length} and take out EVERYTHING you can ` +
      `reach. Do not count anything — the script reads back which slots went empty and works out ` +
      `how many you could get at.`,
  );
  ctx.say('§7Then: `/scriptevent bedshock:probe container.read`§r  (and `container.clear` after)');
}

/**
 * `/scriptevent bedshock:probe container.read` — the discovery pass, read back.
 *
 * Every slot was filled with a marker; a person has just emptied each container by hand. The
 * slots that are now empty are the ones they could reach, so the count comes out of container
 * state rather than out of somebody's memory of a screen.
 *
 * WHAT A PARTIAL PASS LOOKS LIKE, and why it is not silently averaged in. If somebody stops half
 * way, that variant reads as fewer reachable slots than it has, which is indistinguishable from a
 * real limit — so a variant nobody touched at all is reported as untouched rather than as zero
 * reachable, and the verdict says how many variants actually contributed.
 */
export function read(ctx: Ctx): void {
  const raw = world.getDynamicProperty(SPAWNED);
  const ids = typeof raw === 'string' ? (JSON.parse(raw) as string[]) : [];
  if (ids.length === 0) {
    ctx.say('§enothing spawned — run `/scriptevent bedshock:probe container` first.§r');
    return;
  }

  interface Reading {
    id: string;
    container_type: string;
    declared: number;
    /** Slot indices the player emptied. */
    emptied: number[];
    reachable: number;
    /** Are the emptied slots a run from zero, as a drawn grid would be? */
    contiguous: boolean;
  }

  const readings: Reading[] = [];
  for (const id of ids) {
    const entity = world.getEntity(id);
    if (!entity) continue;
    const variant = IDS.containers.find((v) => v.id === entity.typeId);
    const container = entity.getComponent('minecraft:inventory')?.container;
    if (!variant || !container) continue;

    const emptied: number[] = [];
    for (let slot = 0; slot < container.size; slot++) {
      if (container.getItem(slot) === undefined) emptied.push(slot);
    }
    readings.push({
      id: entity.typeId,
      container_type: variant.container_type,
      declared: variant.size,
      emptied,
      reachable: emptied.length,
      // A drawn grid empties from the front. A gap says the layout is not a simple prefix, which
      // is a finding in itself rather than a mistake.
      contiguous: emptied.every((slot, i) => slot === i),
    });
  }

  // A variant nobody touched contributes nothing. Counting it as "zero reachable" would let an
  // abandoned session manufacture the most alarming possible answer.
  const touched = readings.filter((r) => r.reachable > 0);
  if (touched.length === 0) {
    result(
      ctx,
      'entity.container.reachable_slots_match_declared_size',
      'INCONCLUSIVE',
      { readings },
      `none of the ${readings.length} container(s) had anything taken out of them, so nothing was ` +
        `discovered. Empty them by hand first — an untouched container is not a container with no ` +
        `reachable slots.`,
    );
    return;
  }

  const surviving = RULES.filter((rule) => touched.every((r) => rule.of(r.declared) === r.reachable));
  const exact = touched.filter((r) => r.reachable === r.declared);
  const shape = touched.map((r) => `${r.container_type} ${r.declared}->${r.reachable}`).join(', ');

  result(
    ctx,
    'entity.container.reachable_slots_match_declared_size',
    exact.length === touched.length ? 'YES' : 'NO',
    {
      readings,
      touched: touched.length,
      of: readings.length,
      rules_still_standing: surviving.map((r) => r.name),
      rules_tested: RULES.length,
    },
    `${shape}. ` +
      (exact.length === touched.length
        ? 'every declared slot was reachable'
        : `${exact.length}/${touched.length} variants gave up every slot they declared`) +
      (touched.length < readings.length ? `. ${readings.length - touched.length} container(s) were never opened` : '') +
      (surviving.length === 0
        ? '. NO CANDIDATE RULE FITS — the mapping is something none of them describe, which is the ' +
          'most interesting outcome available and wants a look at the raw readings.'
        : surviving.length === 1
          ? `. One rule still fits: ${surviving[0]!.name} — consistent with these sizes, not proven by them.`
          : `. ${surviving.length} of ${RULES.length} rules still fit (${surviving.map((r) => r.name).join('; ')}) — ` +
            `add a size where they disagree to separate them.`) +
      (touched.some((r) => !r.contiguous)
        ? ' Some emptied slots are NOT a run from zero, so the reachable set is not a simple prefix.'
        : ''),
  );
}

/** `/scriptevent bedshock:probe container.clear` */
export function clear(ctx: Ctx): number {
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
  return removed;
}
