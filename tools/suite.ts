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
import { handled, type Vec } from './handling.ts';

type Verdict = 'YES' | 'NO' | 'INCONCLUSIVE';
interface Answer {
  verdict: Verdict;
  measurement?: unknown;
  evidence?: string;
}

interface Live {
  id: string;
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
