/**
 * The suite: what runs by itself while a game is connected, so nobody has to ask for it.
 *
 *   bedshock director suite             run whatever this client has not answered yet
 *   bedshock director suite --retest    run all of it again, on purpose
 *
 * Two kinds of step, and both report the same way:
 *
 *   LIVE   a test that lives here and drives the game by reflection (rows with `probe: director`)
 *   PACK   a probe already in the pack, triggered remotely; its own RESULT lines come back
 *
 * NEVER ASK TWICE. What a client has answered is kept per fingerprint -- platform, memory tier and
 * script API version, all reported by the device itself -- in bridge/answered.json. A row already
 * answered for that fingerprint is skipped unless --retest. Rebuilding the pack is not a retest.
 *
 * Everything lands in bridge/suite-<time>.log as an ordinary battery log, for `bedshock collect`.
 * Nothing here records to the ledger; that stays the deliberate step it is.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Director } from './director.ts';
import { handled, settled, type Vec } from './handling.ts';
import { lab } from './lab.ts';

type Verdict = 'YES' | 'NO' | 'INCONCLUSIVE';
interface Answer {
  verdict: Verdict;
  measurement?: unknown;
  evidence?: string;
}

interface Live {
  id: string;
  /** Moves or relies on the player standing still, so it waits out touch input rather than fight it. */
  still?: boolean;
  run(d: Director): Promise<Answer>;
}

const LIVE: Live[] = [
  {
    id: 'client.system.describes_itself',
    async run(d) {
      const info = (await d.get('player.clientSystemInfo')) as Record<string, unknown>;
      const ok = typeof info?.platformType === 'string';
      return { verdict: ok ? 'YES' : 'NO', measurement: info, evidence: ok ? `${info.platformType}, memory tier ${info.memoryTier}` : 'nothing readable' };
    },
  },
  {
    id: 'client.api.reveals_engine_version',
    async run(d) {
      const look = /version/i;
      const found: string[] = [];
      for (const root of ['system', 'mc', 'world']) {
        for (const k of await d.keys(root)) if (look.test(k) && !/Error$/.test(k)) found.push(`${root}.${k}`);
      }
      return {
        verdict: found.length ? 'YES' : 'NO',
        measurement: { searched: ['system', 'mc', 'world'], found },
        evidence: found.length ? `candidates: ${found.join(', ')}` : 'no version anywhere in system, mc or world',
      };
    },
  },
  {
    id: 'presence.player.teleport_lands_where_asked',
    still: true,
    async run(d) {
      // A fractional offset that a 32-bit float cannot hold far out: .37 is 0.0101111... in binary.
      const frac = 0.37;
      const start = (await d.get('player.location')) as Vec;
      const samples: { distance: number; asked: Vec; got: Vec; error: number }[] = [];
      for (const distance of [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]) {
        const asked = { x: distance + frac, y: 200 + frac, z: distance + frac };
        const got = await handled(d, `teleport ${distance.toLocaleString('en-US')} out`, start, asked, async () =>
          (await d.program([{ call: ['player', 'teleport'], args: [asked] }, { get: ['player', 'location'] }])) as Vec,
        );
        const error = Math.max(Math.abs(got.x - asked.x), Math.abs(got.y - asked.y), Math.abs(got.z - asked.z));
        samples.push({ distance, asked, got, error: Number(error.toPrecision(4)) });
      }
      // The question is the first million blocks; ten million rides along as what happens past it.
      const within = samples.filter((s) => s.distance <= 1_000_000);
      const exact = within.every((s) => s.error < 0.001);
      const first = samples.find((s) => s.error >= 0.001);
      return {
        verdict: exact ? 'YES' : 'NO',
        measurement: { samples },
        evidence: first
          ? `lands within 0.001 out to ${samples[samples.indexOf(first) - 1]?.distance ?? 0}; at ${first.distance} off by ${first.error}`
          : 'within 0.001 everywhere tried, to ten million',
      };
    },
  },
  {
    id: 'storage.structure.round_trips_a_built_room',
    async run(d) {
      await d.call('player.onScreenDisplay.setActionBar', ['§e⟳ building a test room beside you']);
      const r = await lab(d);
      await d.call('player.onScreenDisplay.setActionBar', ['§7room done']);
      const ok = r.identicalCopy && r.identicalAfterRebuild;
      return {
        verdict: ok ? 'YES' : 'NO',
        measurement: r,
        evidence: `${ok ? 'identical' : r.notes.join('; ')} -- ticks: shell ${r.ticks.shell}, terrain ${r.ticks.terrain} (${r.steps} steps), save ${r.ticks.save}, place ${r.ticks.restore}`,
      };
    },
  },
  {
    id: 'storage.region.loads_without_a_player',
    async run(d) {
      const far = { x: 1_000_000, y: 0, z: 1_000_000 };
      const max = (await d.get('world.tickingAreaManager.maxChunkCount')) as number;
      const t0 = (await d.get('system.currentTick')) as number;
      await d.tickingArea('bedshock_far', far, { x: far.x + 15, y: 0, z: far.z + 15 });
      const t1 = (await d.get('system.currentTick')) as number;
      const block = (await d.call('player.dimension.getBlock', [{ x: far.x + 3, y: 64, z: far.z + 3 }]).catch(() => null)) as { typeId?: string } | null;
      await d.call('world.tickingAreaManager.removeTickingArea', ['bedshock_far']).catch(() => {});
      const ok = !!block?.typeId;
      return {
        verdict: ok ? 'YES' : 'NO',
        measurement: { at: far, ticksUntilResolved: t1 - t0, read: block?.typeId ?? null, maxChunkCount: max },
        evidence: ok ? `a million blocks out, readable ${t1 - t0} ticks after asking (network included); ${max} chunks allowed` : 'the area was created but the block did not read',
      };
    },
  },
  {
    id: 'storage.block.exact_at_extreme_coordinates',
    async run(d) {
      const samples: { distance: number; wrote: string; read: string | null; at: unknown; error?: string }[] = [];
      for (const distance of [1_000, 100_000, 10_000_000, 29_999_000]) {
        const at = { x: distance + 3, y: 300, z: distance + 5 };
        const name = `bedshock_x${distance}`;
        try {
          await d.tickingArea(name, at, at);
          await d.program([{ call: ['mc', 'BlockPermutation', 'resolve'], args: ['minecraft:gold_block'] }, { call: ['player', 'dimension', 'setBlockPermutation'], args: [at, { $: 0 }] }]);
          const got = (await d.call('player.dimension.getBlock', [at])) as { typeId?: string; location?: unknown } | null;
          samples.push({ distance, wrote: 'minecraft:gold_block', read: got?.typeId ?? null, at: got?.location ?? null });
          await d.program([{ call: ['mc', 'BlockPermutation', 'resolve'], args: ['minecraft:air'] }, { call: ['player', 'dimension', 'setBlockPermutation'], args: [at, { $: 0 }] }]);
        } catch (err) {
          samples.push({ distance, wrote: 'minecraft:gold_block', read: null, at: null, error: (err as Error).message.slice(0, 160) });
        } finally {
          await d.call('world.tickingAreaManager.removeTickingArea', [name]).catch(() => {});
        }
      }
      const exact = (s: (typeof samples)[number]) => {
        const l = s.at as { x: number; y: number; z: number } | null;
        return s.read === s.wrote && !!l && l.x === s.distance + 3 && l.y === 300 && l.z === s.distance + 5;
      };
      const core = samples.filter((s) => s.distance <= 10_000_000);
      const ok = core.every(exact);
      return {
        verdict: ok ? 'YES' : 'NO',
        measurement: { samples },
        evidence: samples.map((s) => `${s.distance}: ${exact(s) ? 'exact' : s.error ?? `read ${s.read}`}`).join('; '),
      };
    },
  },
  {
    id: 'render.light.script_light_reaches_neighbours',
    async run(d) {
      const me = (await d.get('player.location')) as Vec;
      const src = { x: Math.floor(me.x), y: Math.min(318, Math.floor(me.y) + 12), z: Math.floor(me.z) };
      const probe = { x: src.x + 1, y: src.y, z: src.z };
      const level = async () => (await d.program([{ call: ['player', 'dimension', 'getBlock'], args: [probe] }, { call: ['$0', 'getLightLevel'] }])) as number;
      const place = (block: string, states?: object) =>
        d.program([{ call: ['mc', 'BlockPermutation', 'resolve'], args: [block, ...(states ? [states] : [])] }, { call: ['player', 'dimension', 'setBlockPermutation'], args: [src, { $: 0 }] }]);
      const was = await d.call('world.getTimeOfDay');
      await d.call('world.setTimeOfDay', [18000]);
      const readings: Record<string, number> = { none: await level() };
      for (const l of [15, 7]) {
        await place('minecraft:light_block', { block_light_level: l });
        await new Promise((r) => setTimeout(r, 300));
        readings[`source ${l}`] = await level();
      }
      await place('minecraft:air');
      await new Promise((r) => setTimeout(r, 300));
      readings.removed = await level();
      await d.call('world.setTimeOfDay', [typeof was === 'number' ? was : 6000]);
      const ok = readings['source 15']! > readings.none! && readings['source 7']! < readings['source 15']! && readings.removed === readings.none;
      return { verdict: ok ? 'YES' : 'NO', measurement: { readings, source: src }, evidence: `one block away: ${JSON.stringify(readings)}` };
    },
  },
  {
    id: 'storage.block.bedrock_floor_writable',
    async run(d) {
      const me = (await d.get('player.location')) as Vec;
      const at = { x: Math.floor(me.x), y: -64, z: Math.floor(me.z) };
      const read = async () => ((await d.call('player.dimension.getBlock', [at])) as { typeId?: string } | null)?.typeId ?? null;
      const set = (block: string) => d.program([{ call: ['mc', 'BlockPermutation', 'resolve'], args: [block] }, { call: ['player', 'dimension', 'setBlockPermutation'], args: [at, { $: 0 }] }]);
      const was = await read();
      let wrote: string | null = null, after10s: string | null = null, error: string | undefined;
      try {
        await set('minecraft:gold_block');
        wrote = await read();
        await new Promise((r) => setTimeout(r, 10000));
        after10s = await read();
      } catch (e) {
        error = (e as Error).message.slice(0, 160);
      } finally {
        if (was) await set(was).catch(() => {});
      }
      const ok = wrote === 'minecraft:gold_block' && after10s === 'minecraft:gold_block';
      return {
        verdict: error ? 'INCONCLUSIVE' : ok ? 'YES' : 'NO',
        measurement: { at, was, wrote, after10s, ...(error ? { error } : {}) },
        evidence: error ?? `was ${was}, wrote ${wrote}, after 10 s ${after10s}; ${was} put back`,
      };
    },
  },
  {
    id: 'storage.structure.largest_empty',
    async run(d) {
      const tries = [
        { x: 64, y: 384, z: 64 },
        { x: 96, y: 384, z: 96 },
        { x: 128, y: 384, z: 128 },
        { x: 64, y: 512, z: 64 },
      ];
      const out: { size: Vec; ok: boolean; error?: string }[] = [];
      for (const size of tries) {
        const id = `bedshock:size_${size.x}x${size.y}x${size.z}`;
        try {
          await d.call('world.structureManager.createEmpty', [id, size, 'Memory']);
          out.push({ size, ok: true });
        } catch (e) {
          out.push({ size, ok: false, error: (e as Error).message.slice(0, 140) });
        } finally {
          await d.call('world.structureManager.delete', [id]).catch(() => {});
        }
      }
      const largest = out.filter((o) => o.ok).sort((a, b) => b.size.x * b.size.y * b.size.z - a.size.x * a.size.y * a.size.z)[0];
      return {
        verdict: largest ? 'YES' : 'NO',
        measurement: { tries: out },
        evidence: out.map((o) => `${o.size.x}x${o.size.y}x${o.size.z} ${o.ok ? 'made' : `refused (${o.error})`}`).join('; '),
      };
    },
  },
  {
    id: 'entity.item.nearby_stacks_merge',
    async run(d) {
      // On solid ground, out of the player's reach: straight down from a point 3 blocks beside them,
      // to the first block, and one above it. The first run dropped them over an edge, where they
      // fell out of the counting radius and read as "merged into nothing".
      const me = (await d.get('player.location')) as Vec;
      const over = { x: Math.floor(me.x) + 3.5, y: Math.floor(me.y) + 1, z: Math.floor(me.z) - 6.5 };
      const ground = (await d.call('player.dimension.getBlockFromRay', [over, { x: 0, y: -1, z: 0 }, { maxDistance: 64 }])) as { block?: { location?: Vec } } | null;
      const floor = ground?.block?.location;
      if (!floor) return { verdict: 'INCONCLUSIVE', evidence: 'no ground found to drop onto' };
      const at = { x: floor.x + 0.5, y: floor.y + 1.2, z: floor.z + 0.5 };
      const count = async () =>
        ((await d.program([{ call: ['player', 'dimension', 'getEntities'], args: [{ type: 'minecraft:item', location: at, maxDistance: 3 }] }, { get: ['$0', 'length'] }])) as number) ?? 0;
      const before = await count();
      for (const dx of [0, 0.3]) {
        await d.program([
          { new: ['mc', 'ItemStack'], args: ['minecraft:diamond', 1] },
          { call: ['player', 'dimension', 'spawnItem'], args: [{ $: 0 }, { x: at.x + dx, y: at.y, z: at.z }] },
        ]);
      }
      const spawned = (await count()) - before;
      await new Promise((r) => setTimeout(r, 5000));
      const after = (await count()) - before;
      const keys = (await d.program([
        { call: ['player', 'dimension', 'getEntities'], args: [{ type: 'minecraft:item', location: at, maxDistance: 3 }] },
        { get: ['$0', '0'] },
        { keys: ['$1'] },
      ]).catch(() => [])) as string[];
      const comp = (await d.program([
        { call: ['player', 'dimension', 'getEntities'], args: [{ type: 'minecraft:item', location: at, maxDistance: 3 }] },
        { get: ['$0', '0'] },
        { call: ['$1', 'getComponent'], args: ['minecraft:item'] },
        { keys: ['$2'] },
      ]).catch(() => [])) as string[];
      await d.call('player.runCommand', [`kill @e[type=item,x=${at.x},y=${at.y},z=${at.z},r=3]`]).catch(() => {});
      // "applyDamage" ends in "age"; match the word, not the letters.
      const ageish = [...keys, ...comp].filter((k) => /^age$|[a-z]Age$|despawn|lifetime|persist|pickup/i.test(k));
      return {
        verdict: spawned === 2 && after === 1 ? 'YES' : spawned === 2 ? 'NO' : 'INCONCLUSIVE',
        measurement: { spawned, afterFiveSeconds: after, itemComponent: comp, ageOrDespawnKeys: ageish },
        evidence: `${spawned} dropped, ${after} after 5 s; age/despawn API: ${ageish.join(', ') || 'none'}`,
      };
    },
  },
];

/** Pack probes safe to run with nobody asked: headless rows only, nothing on the player's screen. */
const PACK: { probe: string; rows: string[] }[] = [
  {
    probe: 'storage',
    rows: ['storage.block.state_permutation_bits', 'storage.block.permutations_round_trip_exactly', 'storage.structure.script_edits_read_back'],
  },
];

const DIR = 'bridge';
const ANSWERED = join(DIR, 'answered.json');

function fingerprint(info: Record<string, unknown>, api: string): string {
  return `${info.platformType ?? '?'}/tier${info.memoryTier ?? '?'}/api${api}`;
}

export async function suite(opts: { retest?: boolean; say?: (l: string) => void } = {}): Promise<string> {
  const say = opts.say ?? ((l: string) => process.stdout.write(`${l}\n`));
  const d = new Director();
  mkdirSync(DIR, { recursive: true });

  const info = (await d.get('player.clientSystemInfo')) as Record<string, unknown>;
  const api = await d.api();
  const fp = fingerprint(info, api);
  const answered: Record<string, Record<string, Verdict>> = existsSync(ANSWERED) ? JSON.parse(readFileSync(ANSWERED, 'utf8')) : {};
  const done = (answered[fp] ??= {});
  const skip = (id: string) => !opts.retest && id in done;

  const log = join(DIR, `suite-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const write = (line: string) => {
    appendFileSync(log, `${line}\n`);
    say(line);
  };
  let count = 0;
  const record = (id: string, a: Answer) => {
    count++;
    done[id] = a.verdict;
    const payload = JSON.stringify({ ...(a.measurement !== undefined ? { measurement: a.measurement } : {}), ...(a.evidence ? { evidence: a.evidence } : {}) });
    write(`BEDSHOCK RESULT ${id} ${a.verdict} ${payload}`);
  };

  write(`BEDSHOCK BEGIN ${new Date().toISOString()}`);
  write(`BEDSHOCK NOTE suite client ${fp}${opts.retest ? ' (retest)' : ''}`);

  for (const t of LIVE) {
    if (skip(t.id)) {
      write(`BEDSHOCK SKIP ${t.id} already answered for ${fp}: ${done[t.id]}`);
      continue;
    }
    // Touch input moving the player is the iPad's screen, not the game. Set this one aside -- not
    // answered, so it runs next time -- and carry on with the rest. Never a pause, never a finding.
    if (t.still && !(await settled(d, 5000))) {
      write(`BEDSHOCK SKIP ${t.id} touch input active -- player not still; next run will try again`);
      continue;
    }
    try {
      record(t.id, await t.run(d));
    } catch (err) {
      record(t.id, { verdict: 'INCONCLUSIVE', evidence: `the test could not run: ${(err as Error).message}` });
    }
  }

  for (const p of PACK) {
    const want = p.rows.filter((r) => !skip(r));
    if (!want.length) {
      write(`BEDSHOCK SKIP ${p.probe} every row already answered for ${fp}`);
      continue;
    }
    const lines = await d.runProbe(p.probe);
    for (const line of lines) {
      const m = /BEDSHOCK RESULT (\S+) (YES|NO|INCONCLUSIVE) (.*)$/.exec(line);
      if (!m || !want.includes(m[1]!)) continue;
      count++;
      done[m[1]!] = m[2] as Verdict;
      write(`BEDSHOCK RESULT ${m[1]} ${m[2]} ${m[3]}`);
    }
  }

  write(`BEDSHOCK DONE ${count}`);
  writeFileSync(ANSWERED, `${JSON.stringify(answered, null, 2)}\n`);
  return log;
}
