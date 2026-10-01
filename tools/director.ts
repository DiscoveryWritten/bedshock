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

  program(steps: Step[]): Promise<unknown> {
    return this.rpc('run', { program: steps });
  }

  get(dotted: string) {
    return this.program([{ get: path(dotted) }]);
  }

  keys(dotted: string) {
    return this.program([{ keys: path(dotted) }]);
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
  throw new Error('usage: bedshock director hello | get <path> | keys <path> | call <path> [json args] | program <file.json>');
}
