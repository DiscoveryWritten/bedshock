/**
 * Pages: a run of symbols laid into a structure, cell by cell, and read back.
 *
 * A page DESCRIBES ITSELF. Its first cells hold the seed its body was generated from and the
 * session that wrote it, so a reader can recompute exactly what the writer wrote and tell whether
 * a reload came between them -- with nothing else having to survive. That matters for the
 * persistence probes in particular: a probe that kept its expected answer in a world dynamic
 * property would be measuring dynamic properties as much as structures.
 *
 *   [ seed : cellsFor32 ][ session : cellsFor32 ][ body : sequence(seed) ... ]
 *
 * Cell order is x, then y, then z. Shared by every storage probe, and meant to be the first piece
 * of a paged-state reference implementation (docs/TECHNIQUES.md).
 *
 * WHAT THIS RESTS ON, beyond `symbols.ts`. Durability across a reload or a kill is the caller's
 * to cite, because a page kept only in memory needs neither:
 *
 * @requires bedshock:storage.structure.script_edits_read_back
 */

import { system, type Structure, type Vector3 } from '@minecraft/server';

import { cellsFor32, hash32, pack, sequence, unpack } from './codec.ts';
import { SESSION } from './reload.ts';
import { fromPermutation, toPermutation, type Symbols } from './symbols.ts';

export const cell = (edge: number, i: number): Vector3 => ({
  x: i % edge,
  y: Math.floor(i / edge) % edge,
  z: Math.floor(i / (edge * edge)),
});

export const capacity = (edge: number): number => edge ** 3;

export function write(s: Structure, block: Symbols, edge: number, symbols: readonly number[], start = 0): void {
  symbols.forEach((sym, i) => s.setBlockPermutation(cell(edge, start + i), toPermutation(block, sym)));
}

export function read(s: Structure, block: Symbols, edge: number, count: number, start = 0): (number | undefined)[] {
  return Array.from({ length: count }, (_, i) => fromPermutation(block, s.getBlockPermutation(cell(edge, start + i))));
}

function layout(block: Symbols, edge: number) {
  const header = cellsFor32(block);
  const body = capacity(edge) - 2 * header;
  if (body < 1) throw new Error(`a page of edge ${edge} is too small for a ${block.bits}-bit header`);
  return { header, body };
}

/** The whole page's symbols, header included, for a seed. */
export function pageSymbols(block: Symbols, edge: number, seed: number): number[] {
  const { body } = layout(block, edge);
  return [...pack(block, seed), ...pack(block, hash32(SESSION)), ...sequence(block, seed, body)];
}

export function writePage(s: Structure, block: Symbols, edge: number, seed: number): void {
  write(s, block, edge, pageSymbols(block, edge, seed));
}

/**
 * The same page, written a few cells per yield so `system.runJob` can spread it across ticks.
 * Filling a large page must never itself become the stall a probe is trying to measure.
 */
export function* writePageJob(s: Structure, block: Symbols, edge: number, seed: number): Generator<void, void, void> {
  const symbols = pageSymbols(block, edge, seed);
  for (let i = 0; i < symbols.length; i++) {
    s.setBlockPermutation(cell(edge, i), toPermutation(block, symbols[i]!));
    if (i % 256 === 255) yield;
  }
}

/** Fill a page across ticks, then call back. */
export function fillPage(s: Structure, block: Symbols, edge: number, seed: number, done: (err?: unknown) => void): void {
  const job = writePageJob(s, block, edge, seed);
  system.runJob((function* () {
    try {
      yield* job;
    } catch (err) {
      done(err);
      return;
    }
    done();
  })());
}

export interface PageReading {
  /** The seed in the header, if it decoded. */
  seed?: number;
  /** True when the session in the header is not this one: a reload happened since writing. */
  reloaded?: boolean;
  /** Body cells that came back as exactly the symbol written. */
  matched: number;
  body: number;
  /** The first body cell that did not, for the evidence. */
  firstBad?: number;
}

export function readPage(s: Structure, block: Symbols, edge: number): PageReading {
  const { header, body } = layout(block, edge);
  const seed = unpack(block, read(s, block, edge, header));
  const session = unpack(block, read(s, block, edge, header, header));
  if (seed === undefined) return { matched: 0, body };
  const expected = sequence(block, seed, body);
  const got = read(s, block, edge, body, 2 * header);
  let matched = 0;
  let firstBad: number | undefined;
  got.forEach((g, i) => {
    if (g === expected[i]) matched++;
    else firstBad ??= i;
  });
  return {
    seed,
    ...(session === undefined ? {} : { reloaded: session !== hash32(SESSION) }),
    matched,
    body,
    ...(firstBad === undefined ? {} : { firstBad }),
  };
}
