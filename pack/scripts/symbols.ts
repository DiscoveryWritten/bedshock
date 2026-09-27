/**
 * Blocks as symbols: which declared state blocks the game accepted, and how a number becomes a
 * block permutation and back. The game-facing half of `codec.ts`.
 *
 * Every storage probe goes through this, and so will anything built on them: a pack that stores
 * state in blocks should be using exactly the conversion that was measured, not a copy of it.
 *
 * WHAT THIS RESTS ON. A pack importing this inherits these citations, and through their
 * `depends_on`, everything beneath them:
 *
 * @requires bedshock:storage.block.state_permutation_bits
 * @requires bedshock:storage.block.permutations_round_trip_exactly
 */

import { BlockPermutation, BlockTypes, StructureSaveMode, world } from '@minecraft/server';

import { IDS, NAMESPACE, STATE_PREFIX, type StateBlockId } from './generated.ts';
import { digits, size, undigits } from './codec.ts';
import { firstLine } from './emit.ts';

export type Symbols = StateBlockId;

export interface Acceptance {
  block: Symbols;
  accepted: boolean;
  error?: string;
}

/**
 * Did the game accept each declared state block? A refused definition is simply absent, with
 * no error anywhere; asking for its type and resolving its default permutation is the only way
 * to ask from inside the game.
 */
export function acceptance(): Acceptance[] {
  return IDS.states.map((block) => {
    if (!BlockTypes.get(block.id)) return { block, accepted: false };
    try {
      BlockPermutation.resolve(block.id);
      return { block, accepted: true };
    } catch (err) {
      return { block, accepted: false, error: firstLine(err) };
    }
  });
}

export interface RoundTrip {
  id: string;
  sampled: number;
  wrong: number;
  firstWrong?: number;
}

/**
 * Write `samples` symbols spread across the alphabet into a one-cell memory structure and read
 * each back. A block that exists but does not hold what it declares -- which is what the game does
 * with a block declared past 16 bits -- shows up here as wrong symbols, and nowhere else.
 */
export function roundTrip(block: Symbols, samples: number): RoundTrip {
  const id = `${NAMESPACE}:symbols_roundtrip`;
  world.structureManager.delete(id);
  const cell = world.structureManager.createEmpty(id, { x: 1, y: 1, z: 1 }, StructureSaveMode.Memory);
  const n = Math.min(samples, size(block));
  const step = size(block) / n;
  let wrong = 0;
  let firstWrong: number | undefined;
  try {
    for (let i = 0; i < n; i++) {
      const symbol = Math.floor(i * step);
      cell.setBlockPermutation({ x: 0, y: 0, z: 0 }, toPermutation(block, symbol));
      if (fromPermutation(block, cell.getBlockPermutation({ x: 0, y: 0, z: 0 })) !== symbol) {
        wrong++;
        firstWrong ??= symbol;
      }
    }
  } finally {
    world.structureManager.delete(id);
  }
  return { id: block.id, sampled: n, wrong, ...(firstWrong === undefined ? {} : { firstWrong }) };
}

/** Enough to catch a block that drops a state, cheap enough to ask on every use. */
const QUICK = 64;
let cached: Symbols | null | undefined;

/**
 * The densest accepted block that holds every sampled symbol -- not merely the densest that exists.
 * Asked once per load: the answer cannot change while the pack is running.
 */
export function densest(): Symbols | undefined {
  if (cached === undefined) {
    cached = acceptance()
      .filter((a) => a.accepted && roundTrip(a.block, QUICK).wrong === 0)
      .map((a) => a.block)
      .sort((a, b) => b.bits - a.bits)[0] ?? null;
  }
  return cached ?? undefined;
}

const stateName = (i: number) => `${STATE_PREFIX}${i}`;

export function toPermutation(block: Symbols, symbol: number): BlockPermutation {
  const states = Object.fromEntries(digits(block, symbol).map((d, i) => [stateName(i), d]));
  return BlockPermutation.resolve(block.id, states);
}

/** Undefined when the permutation is not this block, or a state is missing or out of range. */
export function fromPermutation(block: Symbols, perm: BlockPermutation | undefined): number | undefined {
  if (!perm || perm.type.id !== block.id) return undefined;
  const all = perm.getAllStates();
  return undigits(block, Array.from({ length: block.states }, (_, i) => {
    const v = all[stateName(i)];
    return typeof v === 'number' ? v : undefined;
  }));
}
