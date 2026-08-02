/**
 * How large can `max_durability` be?
 *
 * Three findings per ceiling, and they are three different questions:
 *
 *   EXISTS    did Bedrock accept an item declaring this at all. `new ItemStack` throwing IS
 *             the measurement — a rejected item definition is invisible on Bedrock, with no
 *             error anywhere, so this is the only way to ask from inside the game.
 *   REPORTS   does the durability component agree with the number it was given, or silently
 *             land somewhere else.
 *   WRITABLE  can `damage` actually reach the top of the declared range.
 *
 * THE DANGEROUS OUTCOME WAS NEVER REJECTION. It was a silent clamp: the item exists, the pack
 * loads, and every packed value quietly lands somewhere else. A clamp has a safe failure mode
 * and a wrap does not, so the two are recorded as separate capabilities rather than as one
 * "does big durability work" row — and the per-ceiling numbers ride along in the measurement,
 * because a change from wrapping to clamping would leave both verdicts untouched while
 * invalidating everything designed on them.
 *
 * Fully automated and player-independent, which is why a headless run answers all of it.
 */

import { ItemStack } from '@minecraft/server';

import { IDS } from '../generated.ts';
import { firstLine, result, type Ctx } from '../emit.ts';

interface Sample {
  declared: number;
  exists: boolean;
  reports?: number;
  writable?: boolean;
  error?: string;
}

function measure(): Sample[] {
  return IDS.durability.map(({ declared, id }) => {
    let stack: ItemStack;
    try {
      stack = new ItemStack(id, 1);
    } catch (err) {
      return { declared, exists: false, error: firstLine(err) };
    }

    const durability = stack.getComponent('minecraft:durability');
    if (!durability) return { declared, exists: true, error: 'no durability component' };

    const reports = durability.maxDurability;
    let writable: boolean | undefined;
    // Only meaningful when the component reports a sane range. Writing into a negative one
    // throws, and recording that throw as "not writable" would dress up a consequence of the
    // wrap as an independent finding.
    if (reports > 1) {
      try {
        durability.damage = reports - 1;
        writable = durability.damage === reports - 1;
      } catch {
        writable = false;
      }
    }

    return { declared, exists: true, reports, ...(writable === undefined ? {} : { writable }) };
  });
}

export function run(ctx: Ctx): void {
  const samples = measure();

  // --- does everything at or below the boundary report itself? ---
  const inRange = samples.filter((s) => s.declared <= 32767);
  const faithful = inRange.filter((s) => s.exists && s.reports === s.declared);
  const ceilingHolds = inRange.length > 0 && faithful.length === inRange.length;

  result(
    ctx,
    'item.max_durability.int16_ceiling',
    ceilingHolds ? 'YES' : 'NO',
    { samples },
    ceilingHolds
      ? `${faithful.length}/${inRange.length} declared values at or below 32767 report back exactly`
      : `${inRange.length - faithful.length} value(s) at or below 32767 did not report what was declared`,
  );

  // --- above the boundary: wrap, or clamp? ---
  const above = samples.filter((s) => s.declared > 32767 && s.exists && s.reports !== undefined);
  if (above.length === 0) {
    result(ctx, 'item.max_durability.overflow_wraps_rather_than_clamps', 'INCONCLUSIVE', { samples },
      'no above-boundary item exists to read, so a wrap cannot be told from a clamp');
  } else {
    // A wrap is the signed-16-bit turnover: 32768 -> -32768, 65535 -> -1. A clamp would report
    // 32767 for both. Computed rather than pattern-matched against two known values, so a
    // third ceiling added later is covered without editing this.
    const wraps = above.every((s) => {
      const expected = ((((s.declared! + 32768) % 65536) + 65536) % 65536) - 32768;
      return s.reports === expected;
    });
    const clamps = above.every((s) => s.reports === 32767);
    result(
      ctx,
      'item.max_durability.overflow_wraps_rather_than_clamps',
      wraps ? 'YES' : clamps ? 'NO' : 'INCONCLUSIVE',
      { samples: above },
      wraps
        ? 'two’s-complement int16 wraparound, and the item still loads — an over-large value has no safe failure mode'
        : clamps
          ? 'clamped to 32767 rather than wrapping — over-large values degrade safely'
          : `neither a clean wrap nor a clamp: ${above.map((s) => `${s.declared}->${s.reports}`).join(', ')}`,
    );
  }

  // --- is the whole declared range usable? ---
  const writableSamples = inRange.filter((s) => s.writable !== undefined);
  const allWritable = writableSamples.length > 0 && writableSamples.every((s) => s.writable);
  result(
    ctx,
    'item.max_durability.damage_writable_across_range',
    writableSamples.length === 0 ? 'INCONCLUSIVE' : allWritable ? 'YES' : 'NO',
    { samples: writableSamples },
    allWritable
      ? `damage reached max-1 on all ${writableSamples.length} in-range ceilings`
      : `damage could not reach max-1 on ${writableSamples.filter((s) => !s.writable).length} ceiling(s)`,
  );
}
