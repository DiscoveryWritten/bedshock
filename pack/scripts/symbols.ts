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

import { BlockPermutation, BlockTypes } from '@minecraft/server';

import { IDS, STATE_PREFIX, type StateBlockId } from './generated.ts';
import { digits, undigits } from './codec.ts';
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

/** The accepted block with the most bits per symbol, or undefined if none were. */
export function densest(): Symbols | undefined {
  return acceptance()
    .filter((a) => a.accepted)
    .map((a) => a.block)
    .sort((a, b) => b.bits - a.bits)[0];
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
