/**
 * The director: the test server. It sends code into a connected game and reads back what came of
 * it, through the bridge, so the pack never has to know what the tests are.
 *
 *   bedshock director hello                 is a game there, and will it run what it is sent
 *   bedshock director eval '<code>'         run code in the game; prints what it returns
 *   bedshock director run <file.js>         the same, with the code in a file
 *
 * Code runs as the body of an async function with `mc` (@minecraft/server), `world`, `system` and
 * `player` (the first player) in scope; `return` a value and it comes back as JSON.
 *
 * It talks only to the bridge's control port on 127.0.0.1 (tools/bridge.py): POST /command to send,
 * GET /events to follow what the game prints. The pack's side is pack/scripts/rpc.ts.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CONTROL = 19145;
/** Under the length a single command line will carry, with room for the prefix. */
const PART = 1500;

export class Director {
  private cursor = -1;

  constructor(private readonly control = CONTROL) {}

  private url(path: string) {
    return `http://127.0.0.1:${this.control}${path}`;
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
    throw new Error(`no answer to ${method} within ${timeoutMs / 1000}s -- is a game connected, with bedshock 0.1.3 or later?`);
  }

  eval(code: string): Promise<unknown> {
    return this.rpc('eval', { code });
  }
}

export async function main(argv: string[]): Promise<void> {
  const d = new Director();
  const [verb, ...rest] = argv;
  const show = (v: unknown): void => {
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  };
  if (verb === 'hello') return show(await d.rpc('hello'));
  if (verb === 'eval') return show(await d.eval(rest.join(' ')));
  if (verb === 'run' && rest[0]) return show(await d.eval(readFileSync(rest[0], 'utf8')));
  throw new Error('usage: bedshock director hello | eval <code> | run <file.js>');
}
