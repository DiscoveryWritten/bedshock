/**
 * The probe sprites.
 *
 * Written pixel by pixel rather than through any compositing layer, on purpose. For the ruler,
 * exact per-row pixel control IS the measurement — anything sitting between the question and
 * the answer is something that can be wrong in a way the screenshot cannot show.
 *
 * The design rule for everything here: a probe is only worth building if its result is
 * unambiguous. A screenshot that could be read two ways has cost a session and bought nothing.
 */

import { PNG } from 'pngjs';

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function pngFrom(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

export function solid(size: number, hex: string): Buffer {
  const [r, g, b] = hexToRgb(hex);
  return pngFrom(size, size, () => [r, g, b, 255]);
}

/**
 * 16 rows, 16 distinguishable hues, one per row.
 *
 * The bottom five get the most separable colours because that is where the durability bar
 * lands and where the reading has to be exact. An earlier version of this palette used cyan
 * and dodger blue for rows 12 and 13; they are 83 apart in RGB and indistinguishable at hotbar
 * scale. A probe you cannot read is not a cheaper probe, so `assets.test.ts` now fails on any
 * two rows closer than a threshold.
 *
 * Row 15 is the BOTTOM row of the sprite. Read a screenshot from the bottom up.
 */
export const RULER_ROWS = [
  '#202020', '#404040', '#606060', '#808080', // 0-3   dark ramp, up top, deliberately dull
  '#a0a0a0', '#c0c0c0', '#e0e0e0', '#ffffff', // 4-7   light ramp
  '#8b4513', '#ff8c00', '#ffd700', '#00ff00', // 8-11  warm ramp, then the vivid ones begin
  '#00ffff', '#0000ff', '#ff00ff', '#ff0000', // 12-15 primaries only: nothing subtler survives
] as const;                                   //       the hotbar's downscale legibly.

/** Black notches at rows 0, 4, 8 and 12, so rows can be counted rather than estimated. */
export function rulerSprite(): Buffer {
  return pngFrom(16, 16, (x, y) => {
    const [r, g, b] = hexToRgb(RULER_ROWS[y]!);
    if (x === 0 && y % 4 === 0) return [0, 0, 0, 255];
    return [r, g, b, 255];
  });
}

/**
 * A ring: a shape with a hole, so partial-alpha handling shows up as well as colour.
 *
 * A filled square would answer the colour question and silently skip the transparency one,
 * and those are two separate rows in the catalog.
 */
export function ringSprite(size: number, hex: string): Buffer {
  const [r, g, b] = hexToRgb(hex);
  const c = (size - 1) / 2;
  const outer = size / 2 - 0.5;
  const inner = size / 4;
  return pngFrom(size, size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    return d <= outer && d >= inner ? [r, g, b, 255] : [0, 0, 0, 0];
  });
}

/**
 * A vertical strip of `frames` solid tiles — a flipbook source.
 *
 * Deliberately garish and fully saturated: if the icon is cycling at all, it is unmissable,
 * and "I think it might have moved" is not an answer this battery accepts.
 */
export function flipbookStrip(frames: number, size = 16): Buffer {
  const palette = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
  return pngFrom(size, size * frames, (x, y) => {
    const [r, g, b] = hexToRgb(palette[Math.floor(y / size) % palette.length]!);
    return [r, g, b, 255];
  });
}

/**
 * The glyph page: 16x16 cells of `cell` pixels each, filled from the top-left.
 *
 * Unused cells are left fully transparent, which is itself a small question — whether an
 * unused codepoint draws as nothing or as a box.
 */
export function glyphPage(swatches: readonly string[], cell = 16): Buffer {
  const size = cell * 16;
  const rings = swatches.map((hex) => PNG.sync.read(ringSprite(cell, hex)));
  return pngFrom(size, size, (x, y) => {
    const index = Math.floor(y / cell) * 16 + Math.floor(x / cell);
    const ring = rings[index];
    if (!ring) return [0, 0, 0, 0];
    const i = ((y % cell) * cell + (x % cell)) * 4;
    return [ring.data[i]!, ring.data[i + 1]!, ring.data[i + 2]!, ring.data[i + 3]!];
  });
}

/** Codepoint for slot `i` of a glyph page, e.g. page `E2` slot 0 -> U+E200. */
export function glyphChar(page: string, i: number): string {
  return String.fromCodePoint(parseInt(page, 16) * 256 + i);
}

/** Smallest RGB distance between any two ruler rows — the readability the probe depends on. */
export function minimumRowSeparation(rows: readonly string[] = RULER_ROWS): number {
  let min = Infinity;
  for (let i = 0; i < rows.length; i++) {
    for (let k = i + 1; k < rows.length; k++) {
      const a = hexToRgb(rows[i]!);
      const b = hexToRgb(rows[k]!);
      min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  return min;
}
