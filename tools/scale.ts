/**
 * Rendering a measured quantity as one aligned row of text.
 *
 * WHY A GLYPH AND NOT A CHART. A report full of embedded images is a report that goes stale in a
 * different way from the text around it, bloats the repository, and cannot be read in a diff, a
 * terminal, or a pull request. What is actually wanted from a chart here is narrow: *is this
 * number big or small compared to the others, and did it move?* A fixed-width bar in a table
 * column answers that, costs nothing, and survives being pasted anywhere.
 *
 * WHY LOGARITHMIC. The quantities in one column are not the same order of magnitude — a
 * clearance measured in sixteenths of a block sits beside a throw distance measured in tens.
 * Linear, the small ones are all an empty cell and the difference between 0.06 and 0.5 is
 * invisible, which is exactly the difference a tolerance is set from. Log scale gives every
 * decade the same width, so a small number is still a readable length and a tenfold change is
 * always the same visible jump.
 *
 * THE SHAPE. An origin tick, a run of rule, and a cap that marks the value:
 *
 *     ├────●              0.06 blocks
 *     ├──────────●        1.4 blocks
 *     ├─────────────────● 28 blocks
 *
 * Every bar is the same character width whatever it contains, so a column of them aligns and a
 * reader compares lengths rather than parsing numbers. The number is printed too — the bar is
 * for the eye, never the record.
 */

export interface ScaleOptions {
  /** Character width of the rule, not counting the origin tick. */
  width?: number;
  /** Smallest value the scale resolves. Anything at or below sits at the origin. */
  min?: number;
  /** Largest value the scale shows. Anything above pins to the end and is marked. */
  max?: number;
}

const ORIGIN = '├';
const RULE = '─';
const CAP = '●';
/** Something above the top of the scale. A different glyph, because a pinned bar is not a reading. */
const OVER = '▸';
/** Something at or below the bottom. Distinct for the same reason. */
const UNDER = '·';

/**
 * Where a value sits on a log scale from `min` to `max`, as 0..1.
 *
 * Both bounds must be positive — a log scale has no zero, and pretending otherwise by clamping
 * would put a genuine zero and a very small number in the same place. Zero is a different fact
 * from "small", so it gets its own glyph rather than a position.
 */
export function logPosition(value: number, min: number, max: number): number {
  if (!(min > 0) || !(max > min)) throw new Error('a log scale needs 0 < min < max');
  if (!Number.isFinite(value) || value <= min) return 0;
  if (value >= max) return 1;
  return (Math.log(value / min)) / (Math.log(max / min));
}

/**
 * One bar. Always exactly `width + 1` characters, so a column of them lines up.
 */
export function bar(value: number, opts: ScaleOptions = {}): string {
  const width = opts.width ?? 20;
  const min = opts.min ?? 0.01;
  const max = opts.max ?? 100;

  if (!Number.isFinite(value)) return ORIGIN + RULE.repeat(width);
  if (value <= 0) return UNDER + RULE.repeat(width);

  const over = value > max;
  const at = Math.round(logPosition(value, min, max) * (width - 1));
  const head = RULE.repeat(at);
  const tail = RULE.repeat(Math.max(0, width - at - 1));
  return ORIGIN + head + (over ? OVER : CAP) + tail;
}

/**
 * Bounds that fit a set of values, snapped to whole decades.
 *
 * Snapping matters: two reports of the same column should use the same scale so their bars are
 * comparable, and bounds derived from the exact extremes of whatever happened to be measured
 * would shift every time a value did. A decade is a coarse enough unit to be stable and fine
 * enough to be useful.
 */
export function decadeBounds(values: number[]): { min: number; max: number } {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  if (positive.length === 0) return { min: 0.01, max: 100 };
  const lo = Math.min(...positive);
  const hi = Math.max(...positive);
  const min = Math.pow(10, Math.floor(Math.log10(lo)));
  const max = Math.pow(10, Math.ceil(Math.log10(hi)));
  // A single value, or a set inside one decade, still needs a scale with width to it.
  return max > min ? { min, max } : { min, max: min * 10 };
}

/** Trim a measured number to something readable without implying precision it does not have. */
export function formatValue(value: number, unit?: string): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  // Strip trailing zeros only AFTER a decimal point. A blanket strip turns 100 into 1, which is
  // the kind of wrong that looks like a scale bug rather than a formatting one -- it did exactly
  // that to a legend reading "0.01 to 100" before anyone noticed the top of the scale was off by
  // two decades.
  const text = value
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  return unit ? `${text} ${unit}` : text;
}

export interface ScaleRow {
  label: string;
  value: number;
  unit?: string;
}

/**
 * A block of aligned rows — the whole point of the exercise.
 *
 * Labels are padded to a common width and every bar is identical in length, so the caps form a
 * readable profile down the column. That profile is the information: which of these is an order
 * of magnitude larger than the others, and did any of them move since last time.
 */
export function scaleBlock(rows: ScaleRow[], opts: ScaleOptions = {}): string[] {
  if (rows.length === 0) return [];
  const bounds = { ...decadeBounds(rows.map((r) => r.value)), ...opts };
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows.map(
    (row) =>
      `${row.label.padEnd(labelWidth)}  ${bar(row.value, bounds)}  ${formatValue(row.value, row.unit)}`,
  );
}

/**
 * The scale's own legend, so a reader knows what a length means.
 *
 * Printed once per column rather than per row. Without it a log bar is actively misleading: it
 * looks linear, and a reader who assumes that will read a tenfold difference as a small one.
 */
export function legend(min: number, max: number, width = 20): string {
  return `${ORIGIN}${RULE.repeat(width)}  log scale, ${formatValue(min)} to ${formatValue(max)}`;
}
