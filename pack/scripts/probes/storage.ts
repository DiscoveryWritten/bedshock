/**
 * The world as storage: can a pack keep arbitrary state in blocks, in a structure the save
 * file owns, and read it back exactly?
 *
 * THE ROWS STACK, and each one is only meaningful if the one beneath it held:
 *
 *   storage.block.state_permutation_bits          which state blocks exist, and how dense
 *   storage.block.permutations_round_trip_exactly  every symbol comes back as itself
 *   storage.structure.script_edits_read_back       a World-mode structure holds a page
 *   storage.structure.survive_world_reload         ...across quit-to-title     (eyes: stamp/token)
 *   storage.structure.survive_hard_kill            ...across a killed server   (eyes: stamp/token)
 *   storage.structure.save_cost_is_incremental     saving after one change vs after all of them
 *   storage.structure.largest_edge_saved_within_a_tick   the solve
 *
 * A mismatch in a structure row is not a finding about structures until the round-trip row says
 * symbols are exact; `depends_on` in the catalog makes the ledger say so. All the conversion lives
 * in `codec.ts`, `symbols.ts` and `pages.ts`, which is also what a pack using this would import.
 */

import { StructureSaveMode, world, type Structure } from '@minecraft/server';

import { PARAMS, NAMESPACE } from '../generated.ts';
import { SOLVES } from '../catalog.generated.ts';
import { size, hash32 } from '../codec.ts';
import { firstLine, look, result, skipped, willReportLater, type Ctx } from '../emit.ts';
import { fillPage, readPage, writePage } from '../pages.ts';
import { freshToken } from '../reload.ts';
import { solve, type Settle } from '../solve.ts';
import { acceptance, densest, fromPermutation, toPermutation, type Symbols } from '../symbols.ts';

const P = PARAMS.storage;
const ROW = {
  bits: 'storage.block.state_permutation_bits',
  exact: 'storage.block.permutations_round_trip_exactly',
  readBack: 'storage.structure.script_edits_read_back',
  reload: 'storage.structure.survive_world_reload',
  kill: 'storage.structure.survive_hard_kill',
  incremental: 'storage.structure.save_cost_is_incremental',
  tick: 'storage.structure.largest_edge_saved_within_a_tick',
} as const;

const STAMP = `${NAMESPACE}:storage_stamp`;
const sid = (name: string) => `${NAMESPACE}:storage_${name}`;

/** A structure made for one measurement and never mistaken for another run's leftover. */
function fresh(id: string, edge: number, mode = StructureSaveMode.Memory): Structure {
  world.structureManager.delete(id);
  return world.structureManager.createEmpty(id, { x: edge, y: edge, z: edge }, mode);
}

// --- rows 1-3: headless, instant ---------------------------------------------------------------

export function run(ctx: Ctx): void {
  const accepted = acceptance();
  const best = densest();

  result(
    ctx,
    ROW.bits,
    best ? 'YES' : 'INCONCLUSIVE',
    { candidates: accepted.map((a) => ({ id: a.block.id, bits: a.block.bits, accepted: a.accepted, ...(a.error ? { error: a.error } : {}) })) },
    best
      ? `densest accepted: ${best.states} state(s) of ${best.values} = ${best.bits} bits a block`
      : 'no state block was accepted, not even the control -- the apparatus, not the game',
    best?.bits,
  );
  if (!best) {
    for (const r of [ROW.exact, ROW.readBack]) result(ctx, r, 'INCONCLUSIVE', undefined, 'no symbol block to test with');
    stampOrSkip(ctx);
    return;
  }

  // Every accepted block, not just the densest: a symbol that silently becomes another symbol is
  // corruption with no error, and it could happen in one alphabet and not another.
  const scratch = fresh(sid('exact'), 1);
  const exact = accepted.filter((a) => a.accepted).map(({ block }) => {
    const n = Math.min(P.round_trip_samples, size(block));
    const step = size(block) / n;
    let wrong = 0;
    let firstWrong: number | undefined;
    for (let i = 0; i < n; i++) {
      const symbol = Math.floor(i * step);
      scratch.setBlockPermutation({ x: 0, y: 0, z: 0 }, toPermutation(block, symbol));
      if (fromPermutation(block, scratch.getBlockPermutation({ x: 0, y: 0, z: 0 })) !== symbol) {
        wrong++;
        firstWrong ??= symbol;
      }
    }
    return { id: block.id, sampled: n, wrong, ...(firstWrong === undefined ? {} : { firstWrong }) };
  });
  world.structureManager.delete(scratch);
  const allExact = exact.every((e) => e.wrong === 0);
  result(ctx, ROW.exact, allExact ? 'YES' : 'NO', { blocks: exact },
    allExact ? 'every sampled symbol came back as itself' : 'a symbol came back as a different one');

  try {
    const s = fresh(sid('readback'), P.page_edge, StructureSaveMode.World);
    const seed = hash32(freshToken());
    writePage(s, best, P.page_edge, seed);
    s.saveToWorld();
    const again = world.structureManager.get(sid('readback'));
    const reading = again ? readPage(again, best, P.page_edge) : undefined;
    const ok = !!reading && reading.seed === seed && reading.matched === reading.body;
    result(ctx, ROW.readBack, ok ? 'YES' : 'NO', { edge: P.page_edge, block: best.id, reading: reading ?? null },
      ok ? `a ${P.page_edge}^3 page saved and came back through get()` : 'the page did not come back as written');
    world.structureManager.delete(sid('readback'));
  } catch (err) {
    result(ctx, ROW.readBack, 'INCONCLUSIVE', undefined, `could not run the read-back: ${firstLine(err)}`);
  }

  stampOrSkip(ctx);
}

function stampOrSkip(ctx: Ctx): void {
  if (!ctx.player) {
    skipped(ctx, ROW.reload, 'no player connected (headless run)');
    skipped(ctx, ROW.kill, 'no player connected (headless run)');
    return;
  }
  stamp(ctx);
}

// --- rows 4-5: the eyes-only halves ------------------------------------------------------------

/** `/scriptevent bedshock:probe storage.stamp` -- write a page, save it, and say what to do next. */
export function stamp(ctx: Ctx): void {
  const best = densest();
  if (!best) {
    ctx.say('§cNo symbol block was accepted, so there is nothing to stamp with.§r');
    return;
  }
  const s = fresh(STAMP, P.page_edge, StructureSaveMode.World);
  const seed = hash32(freshToken());
  writePage(s, best, P.page_edge, seed);
  s.saveToWorld();
  const at = new Date().toISOString().slice(11, 19);
  look(ctx, ROW.reload,
    `saved a page (seed ${seed}) at ${at}. QUIT TO TITLE, reload, then run /scriptevent ${NAMESPACE}:probe storage.token`);
  look(ctx, ROW.kill,
    `or, for the hard-kill row instead: KILL the server or the app within 10 seconds of ${at} -- no save, no quit -- ` +
      `then start it again and run /scriptevent ${NAMESPACE}:probe storage.token`);
}

/** `/scriptevent bedshock:probe storage.token` -- read the stamped page back. */
export function token(ctx: Ctx): void {
  const best = densest();
  const s = world.structureManager.get(STAMP);
  if (!best || !s) {
    ctx.say(`§cNo stamped page found.§r ${best ? 'The structure is gone.' : 'No symbol block exists.'} ` +
      'If you stamped before the reload, that is the answer: it did not survive.');
    return;
  }
  const r = readPage(s, best, P.page_edge);
  ctx.say(
    `seed §e${r.seed ?? 'unreadable'}§r · body §e${r.matched}/${r.body}§r exact · ` +
      `reload since stamping: ${r.reloaded === undefined ? '§eunknown§r' : r.reloaded ? '§aYES§r' : '§cNO — same session§r'}`,
  );
  if (!r.reloaded) {
    ctx.say('§7A same-session read says nothing about surviving a reload or a kill. Record nothing yet.§r');
    return;
  }
  ctx.say(r.matched === r.body
    ? '§aThe page came back exactly.§r Record it against whichever you did: quit-to-title, or kill.'
    : `§cThe page did not come back exactly§r (first bad cell ${r.firstBad}).`);
}

// --- rows 6-7: slow, and last --------------------------------------------------------------------

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function timeSave(s: Structure): number {
  const t0 = Date.now();
  s.saveToWorld();
  return Date.now() - t0;
}

/**
 * Save a filled structure, then change one cell and save again. If the second save costs about
 * what the first did, saving writes the whole structure; if it is a fraction, only the change.
 */
export function runSave(ctx: Ctx): void {
  const best = densest();
  if (!best) {
    result(ctx, ROW.incremental, 'INCONCLUSIVE', undefined, 'no symbol block to fill with');
    skipped(ctx, ROW.tick, 'no symbol block to fill with');
    return;
  }
  const reported = willReportLater('storage_save');
  const edge = P.save_cost_edge;
  let s: Structure;
  try {
    s = fresh(sid('cost'), edge, StructureSaveMode.World);
  } catch (err) {
    result(ctx, ROW.incremental, 'INCONCLUSIVE', { edge }, `could not create a ${edge}^3 structure: ${firstLine(err)}`);
    reported();
    solveTick(ctx, best);
    return;
  }
  fillPage(s, best, edge, hash32(freshToken()), (err) => {
    try {
      if (err) throw err;
      const full: number[] = [];
      const one: number[] = [];
      for (let i = 0; i < P.save_repeats; i++) {
        // Rewrite every cell with the same symbols, so "full" really is a full change each time.
        full.push(timeSave(s));
        s.setBlockPermutation({ x: 0, y: 0, z: 0 }, toPermutation(best, i % size(best)));
        one.push(timeSave(s));
      }
      const f = median(full);
      const o = median(one);
      const measurement = { edge, block: best.id, full_ms: full, one_cell_ms: one };
      // Under a few milliseconds the clock cannot tell the two apart, and calling that either
      // answer would be grading the clock.
      if (f < 5) {
        result(ctx, ROW.incremental, 'INCONCLUSIVE', measurement, `a full ${edge}^3 save took ${f}ms: too fast to compare`);
      } else {
        const incremental = o < f * 0.25;
        result(ctx, ROW.incremental, incremental ? 'YES' : 'NO', measurement,
          `one cell: ${o}ms against the first save's ${f}ms` + (incremental ? '' : ' -- saving writes the whole structure'));
      }
    } catch (e) {
      result(ctx, ROW.incremental, 'INCONCLUSIVE', undefined, `the save comparison failed: ${firstLine(e)}`);
    } finally {
      world.structureManager.delete(sid('cost'));
      reported();
      solveTick(ctx, best);
    }
  });
}

/** The largest cube edge whose full save fits inside one tick. */
function solveTick(ctx: Ctx, best: Symbols): void {
  const spec = SOLVES.find((x) => x.id === ROW.tick);
  if (!spec) {
    skipped(ctx, ROW.tick, 'the catalog no longer declares this as a solved row');
    return;
  }
  const trial = (x: number, settle: Settle) => {
    const edge = Math.max(2, Math.round(x));
    let s: Structure;
    try {
      s = fresh(sid('tick'), edge, StructureSaveMode.World);
    } catch (err) {
      // A structure the game will not create at this size cannot be saved at it either.
      settle(false, `createEmpty refused ${edge}^3: ${firstLine(err)}`);
      return;
    }
    fillPage(s, best, edge, hash32(freshToken()), (err) => {
      if (err) {
        world.structureManager.delete(sid('tick'));
        settle(null, `filling ${edge}^3 failed: ${firstLine(err)}`);
        return;
      }
      const ms = timeSave(s);
      world.structureManager.delete(sid('tick'));
      settle(ms <= P.tick_budget_ms, `${edge}^3 saved in ${ms}ms`);
    });
  };
  solve(ctx, {
    capability: ROW.tick,
    probe: 'storage_save',
    unit: spec.unit,
    direction: spec.direction,
    from: spec.from,
    to: spec.to,
    tolerance: spec.tolerance,
    repeats: P.solve.repeats,
    maxTrials: P.solve.max_trials,
    cooldown: 4,
    // A 64^3 fill is a quarter of a million cells spread across ticks; give it room.
    trialTimeout: 6000,
  }, trial);
}
