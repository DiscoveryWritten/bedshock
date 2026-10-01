/**
 * The firmware: a pack that does not need to know what the tests are.
 *
 * The test server (tools/director.ts) sends a request as `/scriptevent bedshock:rpc` through the
 * script debugger; this runs it and prints the answer, which the bridge carries back.
 *
 *   /scriptevent bedshock:rpc <id> <i>/<n> <part>     one part of a request; parts are joined, then
 *                                                     decoded (percent-encoding: one command line)
 *   BEDSHOCK RPC <id> OK <json>                       the answer
 *   BEDSHOCK RPC <id> ERR <message>
 *
 * REFLECTION, NOT EVAL. Bedrock refuses to compile code a pack receives ("Function from string is
 * not supported" -- harness.eval.compiles_received_code). So a request is not code; it is a program
 * of steps over the game's own script API, by name, and the API itself is the list of what can be
 * done. Nothing here enumerates primitives:
 *
 *   { "get":  ["player", "location"] }                 walk properties from a root or a step
 *   { "call": ["world", "getPlayers"], "args": [] }    call a method, `this` being its owner
 *   { "new":  ["mc", "ItemStack"], "args": ["minecraft:apple", 3] }
 *   { "keys": ["player"] }                             what this object actually has, in this client
 *
 * A path starts at a root -- `mc` (@minecraft/server), `world`, `system`, `player` -- or at an earlier
 * step, `"$0"`, `"$1"`... An argument `{ "$": 2 }` is the result of step 2. The answer is the last
 * step's value, described: plain values as they are, game objects by their readable properties.
 *
 * Requests only arrive through the script debugger, which only a machine the player pointed the game
 * at can be; that connection is the authority, as it is for any debugger.
 */

import * as mc from '@minecraft/server';
import { system, world, type Player } from '@minecraft/server';

import { PACK_VERSION } from './generated.ts';
import { snapshot } from './probes/presence.ts';

type Step = { get?: unknown[]; call?: unknown[]; new?: unknown[]; keys?: unknown[]; args?: unknown[] };

const parts = new Map<string, (string | undefined)[]>();

// --- describing what comes back -----------------------------------------------------------------

/** Every property name up the prototype chain, short of Object itself. */
function names(o: object): string[] {
  const out = new Set<string>();
  for (let p: object | null = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor') out.add(k);
  }
  return [...out].sort();
}

/**
 * A value as JSON can carry it. Game objects keep their state behind getters on the prototype, which
 * JSON.stringify never sees, so they are walked by name: readable values kept, methods listed.
 */
export function describe(v: unknown, depth = 2): unknown {
  if (v === null || v === undefined || typeof v !== 'object') {
    return typeof v === 'function' ? `[function ${(v as Function).name}]` : v ?? null;
  }
  if (depth < 0) return `[${(v as object).constructor?.name ?? 'object'}]`;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => describe(x, depth - 1));
  const out: Record<string, unknown> = { $type: (v as object).constructor?.name ?? 'Object' };
  const methods: string[] = [];
  for (const k of names(v).slice(0, 80)) {
    let x: unknown;
    try {
      x = (v as Record<string, unknown>)[k];
    } catch (err) {
      out[k] = `[throws ${String(err).split('\n')[0]}]`;
      continue;
    }
    if (typeof x === 'function') methods.push(k);
    else out[k] = describe(x, depth - 1);
  }
  if (methods.length) out.$methods = methods;
  return out;
}

// --- running a program ------------------------------------------------------------------------

function resolve(path: unknown[], roots: Record<string, unknown>, steps: unknown[]): { owner: unknown; value: unknown } {
  const [head, ...rest] = path.map(String);
  let value: unknown = /^\$\d+$/.test(head ?? '') ? steps[Number(head!.slice(1))] : roots[head ?? ''];
  if (value === undefined && !(head! in roots) && !/^\$\d+$/.test(head ?? '')) throw new Error(`no root ${head}`);
  let owner: unknown;
  for (const k of rest) {
    owner = value;
    value = (value as Record<string, unknown>)[k];
  }
  return { owner, value };
}

function args(list: unknown[] | undefined, steps: unknown[]): unknown[] {
  return (list ?? []).map((a) =>
    a && typeof a === 'object' && !Array.isArray(a) && typeof (a as { $?: unknown }).$ === 'number' ? steps[(a as { $: number }).$] : a,
  );
}

export async function runProgram(program: Step[], player: Player | undefined): Promise<unknown> {
  const roots: Record<string, unknown> = { mc, world, system, player };
  const steps: unknown[] = [];
  for (const [i, step] of program.entries()) {
    let v: unknown;
    if (step.get) {
      v = resolve(step.get, roots, steps).value;
    } else if (step.call) {
      const { owner, value } = resolve(step.call, roots, steps);
      if (typeof value !== 'function') throw new Error(`step ${i}: ${step.call.join('.')} is not a function`);
      v = await (value as Function).apply(owner, args(step.args, steps));
    } else if (step.new) {
      const { value } = resolve(step.new, roots, steps);
      v = new (value as new (...a: unknown[]) => unknown)(...args(step.args, steps));
    } else if (step.keys) {
      v = names(Object(resolve(step.keys, roots, steps).value));
    } else {
      throw new Error(`step ${i}: needs one of get, call, new, keys`);
    }
    steps.push(v);
  }
  return steps[steps.length - 1];
}

// --- the wire -------------------------------------------------------------------------------------

function reply(id: string, ok: boolean, value: unknown): void {
  let text: string;
  try {
    text = ok ? JSON.stringify(describe(value, 3)) : String(value);
  } catch (err) {
    ok = false;
    text = `the answer could not be described: ${String(err)}`;
  }
  console.warn(`BEDSHOCK RPC ${id} ${ok ? 'OK' : 'ERR'} ${text}`);
}

const METHODS: Record<string, (args: any, player: Player | undefined) => unknown> = {
  hello: () => ({ pack: PACK_VERSION, players: world.getPlayers().length, methods: Object.keys(METHODS) }),
  players: () => world.getPlayers().map(snapshot),
  run: (a, player) => runProgram(Array.isArray(a?.program) ? a.program : [], player),
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
