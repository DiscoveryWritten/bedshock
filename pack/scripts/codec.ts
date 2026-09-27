/**
 * Numbers as symbols, and symbols as numbers. Pure: no game imports, so it is tested in Node.
 *
 * A block with S integer states of V values each is one symbol from an alphabet of V^S. These
 * are the conversions every storage probe -- and anything built on them later -- needs, written
 * once:
 *
 *   digits / undigits   a symbol <-> its per-state values (mixed radix, state 0 least significant)
 *   pack / unpack       a 32-bit number <-> the fewest symbols that hold it
 *   sequence            a deterministic run of symbols from a seed, so a reader can recompute what
 *                       a writer wrote without anything else having survived
 *   hash32              a string to a 32-bit seed
 */

export interface Alphabet {
  states: number;
  values: number;
}

export const size = (a: Alphabet): number => a.values ** a.states;

/** Symbol -> one value per state. */
export function digits(a: Alphabet, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.states; i++) {
    out.push(n % a.values);
    n = Math.floor(n / a.values);
  }
  return out;
}

/** One value per state -> symbol. Undefined if any value is out of range, which is corruption. */
export function undigits(a: Alphabet, ds: readonly (number | undefined)[]): number | undefined {
  let n = 0;
  for (let i = a.states - 1; i >= 0; i--) {
    const d = ds[i];
    if (d === undefined || !Number.isInteger(d) || d < 0 || d >= a.values) return undefined;
    n = n * a.values + d;
  }
  return n;
}

/** How many symbols a 32-bit number needs in this alphabet. */
export const cellsFor32 = (a: Alphabet): number => Math.ceil(32 / Math.log2(size(a)));

export function pack(a: Alphabet, n: number): number[] {
  let rest = n >>> 0;
  return Array.from({ length: cellsFor32(a) }, () => {
    const d = rest % size(a);
    rest = Math.floor(rest / size(a));
    return d;
  });
}

export function unpack(a: Alphabet, symbols: readonly (number | undefined)[]): number | undefined {
  let n = 0;
  for (let i = cellsFor32(a) - 1; i >= 0; i--) {
    const s = symbols[i];
    if (s === undefined) return undefined;
    n = n * size(a) + s;
  }
  return n >>> 0;
}

export function hash32(text: string): number {
  // FNV-1a. Nothing about this needs to be secure, only stable and well spread.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `count` symbols from `seed` (mulberry32). The same seed always gives the same run. */
export function sequence(a: Alphabet, seed: number, count: number): number[] {
  let t = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const u = ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    out.push(Math.floor(u * size(a)));
  }
  return out;
}
