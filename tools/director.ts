/**
 * The director: the test server. It drives a connected game through the bridge, so the pack never
 * has to know what the tests are.
 *
 *   bedshock director hello                        is a game there, and what will it take
 *   bedshock director get player.location          read anything, by its path in the script API
 *   bedshock director keys player                  what an object actually has, in this client
 *   bedshock director call world.getPlayers [args] call a method; args as a JSON array
 *   bedshock director program <file.json>          run a whole program (see pack/scripts/rpc.ts)
 *
 * The game will not run code it is sent (harness.eval.compiles_received_code is NO), so a request
 * is a program of steps over the game's own API, by name. Roots: mc, world, system, player.
 *
 * It talks only to the bridge's control port on 127.0.0.1 (tools/bridge.py): POST /command to send,
 * GET /events to follow what the game prints.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CONTROL = 19145;
/** Under the length a single command line will carry, with room for the prefix. */
const PART = 1500;

export type Step = { get?: string[]; call?: string[]; new?: string[]; keys?: string[]; args?: unknown[] };

const path = (dotted: string) => dotted.split('.').filter(Boolean);

export class Director {
  private cursor = -1;

  constructor(private readonly control = CONTROL) {}

  private url(p: string) {
    return `http://127.0.0.1:${this.control}${p}`;
  }

  async command(line: string): Promise<void> {
    const res = await fetch(this.url('/command'), { method: 'POST', body: line });
    if (!res.ok) throw new Error((await res.text()).trim());
  }

  /** Lines the game printed since the last call. The first call only finds out where "now" is. */
  async lines(): Promise<string[]> {
    const res = await fetch(this.url(`/events?since=${this.cursor}`));
    const { next, lines } = (await res.json()) as { next: number; lines: string[] };
    this.cursor = next;
    return lines;
  }

  async rpc(method: string, args: unknown = {}, timeoutMs = 20000): Promise<unknown> {
    if (this.cursor < 0) await this.lines();
    const id = randomUUID().slice(0, 8);
    const payload = encodeURIComponent(JSON.stringify({ method, args }));
    const n = Math.max(1, Math.ceil(payload.length / PART));
    for (let i = 0; i < n; i++) {
      await this.command(`scriptevent bedshock:rpc ${id} ${i + 1}/${n} ${payload.slice(i * PART, (i + 1) * PART)}`);
    }
    const answer = new RegExp(`BEDSHOCK RPC ${id} (OK|ERR) (.*)$`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const line of await this.lines()) {
        const m = answer.exec(line);
        if (!m) continue;
        if (m[1] === 'ERR') throw new Error(m[2]);
        return JSON.parse(m[2]!);
      }
    }
    throw new Error(`no answer to ${method} within ${timeoutMs / 1000}s -- is a game connected, with bedshock 0.1.4 or later?`);
  }

  /** The script API the client runs, as the bridge noted it from the load lines. */
  async api(): Promise<string> {
    const res = await fetch(this.url('/events?since=0'));
    const { lines } = (await res.json()) as { lines: string[] };
    const notes = lines.map((l) => /client runs @minecraft\/server (\S+)/.exec(l)?.[1]).filter(Boolean);
    return notes.at(-1) ?? 'unknown';
  }

  /** Trigger a probe already in the pack and collect what it prints, up to its DONE. */
  async runProbe(name: string, timeoutMs = 180000): Promise<string[]> {
    if (this.cursor < 0) await this.lines();
    else await this.lines();
    await this.command(`scriptevent bedshock:probe ${name}`);
    const seen: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const line of await this.lines()) {
        seen.push(line);
        if (/BEDSHOCK DONE \d+/.test(line)) return seen;
      }
    }
    throw new Error(`probe ${name} did not finish within ${timeoutMs / 1000}s`);
  }

  program(steps: Step[]): Promise<unknown> {
    return this.rpc('run', { program: steps });
  }

  /** Subscribe to a world event on the device; firings arrive as `BEDSHOCK EVENT <id> ...` lines. */
  async tap(event: string, phase: 'before' | 'after' = 'after', cancel?: { item?: string; block?: string }): Promise<string> {
    return ((await this.rpc('tap', { event, phase, ...(cancel ? { cancel } : {}) })) as { tap: string }).tap;
  }

  /** Run a program every `every` ticks on the device; changes arrive as `BEDSHOCK WATCH <id> ...`. */
  async watch(program: Step[], every = 1): Promise<string> {
    return ((await this.rpc('watch', { program, every })) as { watch: string }).watch;
  }

  stop(id: string) {
    return this.rpc('stop', { id });
  }

  get(dotted: string) {
    return this.program([{ get: path(dotted) }]);
  }

  /**
   * Every name an object has. Paged through the list's own `slice`, 50 at a time, because packs up
   * to 0.1.4 cap any list they send at 50 -- so this works without anyone installing a new pack.
   */
  async keys(dotted: string): Promise<string[]> {
    const all: string[] = [];
    for (let from = 0; ; from += 50) {
      const page = (await this.program([{ keys: path(dotted) }, { call: ['$0', 'slice'], args: [from, from + 50] }])) as string[];
      all.push(...page);
      if (page.length < 50) return all;
    }
  }

  call(dotted: string, args: unknown[] = []) {
    return this.program([{ call: path(dotted), args }]);
  }
}

export async function main(argv: string[]): Promise<void> {
  const d = new Director();
  const [verb, target, extra] = argv;
  const show = (v: unknown): void => {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  };
  if (verb === 'hello') return show(await d.rpc('hello'));
  if (verb === 'get' && target) return show(await d.get(target));
  if (verb === 'keys' && target) return show(await d.keys(target));
  if (verb === 'call' && target) return show(await d.call(target, extra ? JSON.parse(extra) : []));
  if (verb === 'program' && target) return show(await d.program(JSON.parse(readFileSync(target, 'utf8'))));
  if (verb === 'suite') {
    const { suite } = await import('./suite.ts');
    process.stdout.write(`log: ${await suite({ retest: argv.includes('--retest') })}\n`);
    return;
  }
  throw new Error('usage: bedshock director hello | get <path> | keys <path> | call <path> [json args] | program <file.json> | suite [--retest]');
}
