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
