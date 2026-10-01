/**
 * The firmware: a pack that does not need to know what the tests are.
 *
 * The test server (tools/director.ts, on the machine running the bridge) sends a request as a
 * `/scriptevent bedshock:rpc` through the script debugger; this runs it and prints the answer,
 * which the bridge carries back. Tests live on the server. Changing one never rebuilds the pack.
 *
 *   /scriptevent bedshock:rpc <id> <i>/<n> <part>     one part of a request; parts are joined, then
 *                                                     decoded (percent-encoding: one command line)
 *   BEDSHOCK RPC <id> OK <json>                       the answer
 *   BEDSHOCK RPC <id> ERR <message>
 *
 * A request is `{ method, args }`. `eval` is the method that makes the rest unnecessary: run this
 * code, with the game modules and the player in scope, and return what it returns. Requests can
 * only arrive through the script debugger, which only a machine the player pointed the game at can
 * be; that connection is the authority, as it is for any debugger.
 */

import * as mc from '@minecraft/server';
import { system, world, type Player } from '@minecraft/server';

import { PACK_VERSION } from './generated.ts';
import { snapshot } from './probes/presence.ts';

const parts = new Map<string, (string | undefined)[]>();

function reply(id: string, ok: boolean, value: unknown): void {
  let text: string;
  try {
    text = ok ? JSON.stringify(value ?? null) : String(value);
  } catch (err) {
    ok = false;
    text = `the answer could not be serialised: ${String(err)}`;
  }
  console.warn(`BEDSHOCK RPC ${id} ${ok ? 'OK' : 'ERR'} ${text}`);
}

/** Compile `code` as the body of an async function. Throws if the game does not allow it. */
export function compile(code: string): (...args: unknown[]) => Promise<unknown> {
  return new Function('mc', 'world', 'system', 'player', `return (async () => {\n${code}\n})();`) as never;
}

const METHODS: Record<string, (args: any, player: Player | undefined) => unknown> = {
  hello: () => {
    let evalOk: boolean;
    try {
      evalOk = typeof compile('return 1') === 'function';
    } catch {
      evalOk = false;
    }
    return { pack: PACK_VERSION, eval: evalOk, players: world.getPlayers().length };
  },
  players: () => world.getPlayers().map(snapshot),
  eval: (args, player) => compile(String(args?.code ?? ''))(mc, world, system, player),
};

export function handle(message: string, source: Player | undefined): void {
  const m = /^(\S+) (\d+)\/(\d+) (\S*)$/.exec(message.trim());
  if (!m) return void console.warn('BEDSHOCK NOTE rpc: could not read a request part');
  const id = m[1]!;
  const i = Number(m[2]);
  const n = Number(m[3]);
  const got = parts.get(id) ?? Array<string | undefined>(n).fill(undefined);
  got[i - 1] = m[4]!;
  parts.set(id, got);
  if (got.some((p) => p === undefined)) return;
  parts.delete(id);

  let request: { method?: string; args?: unknown };
  try {
    request = JSON.parse(decodeURIComponent(got.join('')));
  } catch (err) {
    return reply(id, false, `bad request: ${String(err)}`);
  }
  const method = METHODS[request.method ?? ''];
  if (!method) return reply(id, false, `no method ${request.method}; have ${Object.keys(METHODS).join(', ')}`);

  // Commands from the debugger have no player behind them; the first player is the one playing.
  const player = source ?? world.getPlayers()[0];
  // Out of the event, so a request may do anything a tick may do.
  system.run(async () => {
    try {
      reply(id, true, await method(request.args, player));
    } catch (err) {
      reply(id, false, String(err));
    }
  });
}
