/**
 * A QR encoder, so a session's answers can leave the game without anybody typing them.
 *
 * WHY THIS EXISTS. A Minecraft client has no network — `@minecraft/server-net` is Dedicated
 * Server only — so the screen is the only channel out. That was already true when the answer code
 * was invented; what the code could not solve is SCALE. Reading twenty-five characters off a
 * screen and handing them to somebody works when the somebody is one person who wrote the pack.
 * It does not work for a thousand strangers, and a battery whose results depend on strangers
 * doing transcription is a battery that collects nothing.
 *
 * A camera does not mistype. So the session builds the code as a QR out of blocks, stands you
 * above it looking straight down, and you photograph it — with the same phone you are playing on,
 * or another one pointed at the screen.
 *
 * ZERO IMPORTS, DELIBERATELY. This is arithmetic, and arithmetic can be checked on a machine with
 * no Minecraft on it. `tools/qr.test.ts` round-trips every matrix this produces through `jsqr` —
 * a completely separate implementation — because an encoder that is subtly wrong produces a code
 * that simply does not scan, and "it did not scan" is indistinguishable from a bad photograph,
 * a bad screen, or a bad angle. An instrument checked only by itself is the failure this whole
 * repository is organised against.
 *
 * ALPHANUMERIC MODE ONLY, and that is a design constraint on the payload rather than a
 * limitation. QR's alphanumeric alphabet is `0-9 A-Z $%*+-./:` — which covers an uppercase URL
 * and a Crockford base32 code with its dashes, and encodes at 5.5 bits per character instead of
 * 8. Byte mode would cost a third more modules, and modules are blocks somebody has to be able to
 * see in one screenshot.
 *
 * ERROR CORRECTION LEVEL Q — 25%. Higher than the usual choice on purpose: this code is rendered
 * as blocks, lit by whatever the game's lighting does, and photographed off a screen at an angle.
 * A quarter of the symbol can be unreadable and it still decodes.
 */

/** QR's alphanumeric alphabet. Index IS the value; the order is from the specification. */
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Error-correction level Q, as the format information encodes it. */
const ECC_Q_BITS = 0b11;

/**
 * Everything that varies by version, for level Q only.
 *
 * `groups` is the block structure: each entry is [block count, data codewords per block]. Two
 * entries means the version splits into two group sizes, which is what makes interleaving
 * non-trivial and is the part an encoder most often gets quietly wrong.
 */
interface VersionSpec {
  version: number;
  /** Error-correction codewords per block. */
  ecPerBlock: number;
  groups: [number, number][];
  /** Row/column centres for alignment patterns. Empty for version 1. */
  alignment: number[];
  /** How many alphanumeric characters fit. */
  capacity: number;
}

const VERSIONS: VersionSpec[] = [
  { version: 1, ecPerBlock: 13, groups: [[1, 13]], alignment: [], capacity: 16 },
  { version: 2, ecPerBlock: 22, groups: [[1, 22]], alignment: [6, 18], capacity: 29 },
  { version: 3, ecPerBlock: 18, groups: [[2, 17]], alignment: [6, 22], capacity: 47 },
  { version: 4, ecPerBlock: 26, groups: [[2, 24]], alignment: [6, 26], capacity: 67 },
  { version: 5, ecPerBlock: 18, groups: [[2, 15], [2, 16]], alignment: [6, 30], capacity: 85 },
  { version: 6, ecPerBlock: 24, groups: [[4, 19]], alignment: [6, 34], capacity: 106 },
  // Version 7 exists for headroom rather than for today. A full session of 35 eyes-only answers
  // is a 77-character code, and the URL around it makes 112 -- over version 6's 106. Stopping at
  // 6 would mean the QR worked in testing and failed on the first complete run somebody did.
  { version: 7, ecPerBlock: 18, groups: [[2, 14], [4, 15]], alignment: [6, 22, 38], capacity: 122 },
];

/**
 * Version 7 is the ceiling.
 *
 * Version 7 and up carry an 18-bit version block in two corners -- more spec surface, and the
 * reason the first cut stopped at 6. That was wrong: a real session's payload is 112 characters
 * and version 6 holds 106, so the symbol would have worked on every short test payload and failed
 * the first time somebody answered everything. Past 7 the symbol gets big enough that fitting it
 * in one photograph starts costing module size, which is the thing a scanner actually needs.
 */
export const MAX_CAPACITY = VERSIONS[VERSIONS.length - 1]!.capacity;

// ---------------------------------------------------------------------------
// GF(256), for Reed-Solomon
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // The QR field polynomial: x^8 + x^4 + x^3 + x^2 + 1.
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/**
 * The generator polynomial for `degree` error-correction codewords: the product of (x - a^i).
 *
 * RETURNED IN DESCENDING ORDER WITH THE MONIC LEADING TERM DROPPED, which is what the division
 * below consumes. It is built ascending because that is the natural way to multiply, and the
 * mismatch between the two conventions is not a detail: getting it wrong produces error-correction
 * codewords that are wrong in a way NOTHING structural can see. The finders, timing, format,
 * masking and data placement all still verify perfectly, the symbol simply does not decode, and
 * the only thing that catches it is a separate implementation reading the result.
 */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ mul(poly[j]!, EXP[i]!);
      next[j + 1] = (next[j + 1] ?? 0) ^ poly[j]!;
    }
    poly = next;
  }
  // `poly` is ascending with poly[degree] === 1. The divisor wants the other convention.
  return poly.slice(0, degree).reverse();
}

function remainder(data: number[], degree: number): number[] {
  const gen = generator(degree);
  const out = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0]!;
    out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] = out[i]! ^ mul(gen[i]!, factor);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The bit stream
// ---------------------------------------------------------------------------

class Bits {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }
}

function encodeAlphanumeric(text: string, spec: VersionSpec): number[] {
  const bits = new Bits();
  bits.push(0b0010, 4); // alphanumeric mode
  // 9 bits of character count for versions 1..9. Versions past 9 widen it, which is one more
  // reason the ceiling is version 6.
  bits.push(text.length, 9);

  for (let i = 0; i < text.length; i += 2) {
    const first = ALPHANUMERIC.indexOf(text[i]!);
    if (first < 0) throw new Error(`"${text[i]}" is not in QR's alphanumeric alphabet`);
    if (i + 1 < text.length) {
      const second = ALPHANUMERIC.indexOf(text[i + 1]!);
      if (second < 0) throw new Error(`"${text[i + 1]}" is not in QR's alphanumeric alphabet`);
      bits.push(first * 45 + second, 11);
    } else {
      bits.push(first, 6);
    }
  }

  const dataCodewords = spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
  const capacityBits = dataCodewords * 8;
  if (bits.length > capacityBits) throw new Error('payload does not fit the chosen version');

  // Terminator, then pad to a byte boundary, then the specified alternating pad bytes.
  bits.push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits.bits[i + j]!;
    codewords.push(byte);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCodewords; i++) codewords.push(PAD[i % 2]!);
  return codewords;
}

/**
 * Split into blocks, compute each block's error correction, and interleave.
 *
 * THE INTERLEAVING IS THE PART THAT FAILS SILENTLY. Get it wrong and every structural check still
 * passes — finders, timing, format — and the symbol simply does not decode. That is why the test
 * round-trips through a separate decoder rather than asserting on the matrix's shape.
 */
function codewordsFor(text: string, spec: VersionSpec): number[] {
  const data = encodeAlphanumeric(text, spec);

  const blocks: number[][] = [];
  const eccs: number[][] = [];
  let at = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      blocks.push(block);
      eccs.push(remainder(block, spec.ecPerBlock));
    }
  }

  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ecc of eccs) out.push(ecc[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/** `true` is a dark module. `undefined` in the working matrix means "not yet placed". */
type Cell = boolean | undefined;

function place(size: number): { grid: Cell[][]; reserved: boolean[][] } {
  const grid: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(undefined));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { grid, reserved };
}

function drawFinder(grid: Cell[][], reserved: boolean[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= grid.length || cc >= grid.length) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[rr]![cc] = inRing || inCore;
      reserved[rr]![cc] = true;
    }
  }
}

function drawAlignment(grid: Cell[][], reserved: boolean[][], centres: number[]): void {
  for (const row of centres) {
    for (const col of centres) {
      // The three corners already carry finder patterns.
      if (reserved[row]?.[col]) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          grid[row + r]![col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          reserved[row + r]![col + c] = true;
        }
      }
    }
  }
}

function buildMatrix(spec: VersionSpec, codewords: number[], mask: number): boolean[][] {
  const size = spec.version * 4 + 17;
  const { grid, reserved } = place(size);

  drawFinder(grid, reserved, 0, 0);
  drawFinder(grid, reserved, 0, size - 7);
  drawFinder(grid, reserved, size - 7, 0);
  drawAlignment(grid, reserved, spec.alignment);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    grid[6]![i] = i % 2 === 0;
    reserved[6]![i] = true;
    grid[i]![6] = i % 2 === 0;
    reserved[i]![6] = true;
  }

  // The dark module, and the format-information areas around each finder.
  grid[size - 8]![8] = true;
  reserved[size - 8]![8] = true;
  for (let i = 0; i < 9; i++) {
    if (!reserved[8]![i]) reserved[8]![i] = true;
    if (!reserved[i]![8]) reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }

  // The version blocks, from version 7 up: two 3x6 areas, one above the bottom-left finder and
  // one left of the top-right one. Reserved BEFORE the data is placed, or the data lands in them
  // and the symbol carries eighteen bits of somebody else's payload where its version should be.
  if (spec.version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      reserved[a]![b] = true;
      reserved[b]![a] = true;
    }
  }

  // The data, zigzagging up and down two columns at a time from the bottom right, skipping the
  // vertical timing column.
  const bits: number[] = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((codeword >> i) & 1);
  }

  let at = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue;
        const bit = at < bits.length ? bits[at++]! : 0;
        grid[row]![col] = maskAt(mask, row, col) ? bit === 0 : bit === 1;
      }
    }
    upward = !upward;
  }

  drawFormat(grid, mask, size);
  if (spec.version >= 7) drawVersion(grid, spec.version, size);
  return grid.map((row) => row.map((cell) => cell === true));
}

/**
 * The version block, for versions 7 and up: six bits of version and twelve of BCH.
 *
 * Written in the same MSB-first order as the format information, and verified the same way --
 * by a separate decoder reading the finished symbol, because there is no structural check that
 * would notice these eighteen bits being backwards.
 */
function drawVersion(grid: Cell[][], version: number, size: number): void {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  const bits = (version << 12) | rem;

  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid[a]![b] = bit;
    grid[b]![a] = bit;
  }
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function drawFormat(grid: Cell[][], mask: number, size: number): void {
  const data = (ECC_Q_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const format = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i < 15; i++) {
    // MSB FIRST. The most significant bit goes at (8, 0) and the run proceeds down; writing them
    // the other way round produces a symbol whose format is self-consistent -- it reads back
    // exactly as written -- and which no scanner on earth can decode.
    const bit = ((format >> (14 - i)) & 1) === 1;
    // Around the top-left finder.
    if (i < 6) grid[8]![i] = bit;
    else if (i === 6) grid[8]![7] = bit;
    else if (i === 7) grid[8]![8] = bit;
    else if (i === 8) grid[7]![8] = bit;
    else grid[14 - i]![8] = bit;
    // And the split copy beside the other two. SEVEN bits go up the left column, not eight:
    // the eighth position, (size - 8, 8), is the dark module, which is always set and is not
    // part of the format at all. Writing eight here overwrites it, and the symbol then fails to
    // decode with every structural check still passing — the format reads back correctly if you
    // read it with the same wrong layout you wrote it with, which is how this survived a
    // round-trip against itself.
    if (i < 7) grid[size - 1 - i]![8] = bit;
    else grid[8]![size - 15 + i] = bit;
  }
}

// ---------------------------------------------------------------------------
// Mask selection
// ---------------------------------------------------------------------------

/**
 * The four penalty rules from the specification, lower being better.
 *
 * Not cosmetic: a symbol with long same-colour runs or large blocks of one colour is one a scanner
 * struggles to lock onto. Rendered as terrain and photographed off a screen, that margin matters
 * more here than it would on paper.
 */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0;

  const run = (get: (a: number, b: number) => boolean): void => {
    for (let a = 0; a < size; a++) {
      let length = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          length++;
          if (length === 5) score += 3;
          else if (length > 5) score += 1;
        } else length = 1;
      }
    }
  };
  run((r, c) => grid[r]![c]!);
  run((c, r) => grid[r]![c]!);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r]![c]!;
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }

  // The finder-lookalike sequence, which a scanner would mistake for a finder pattern.
  const PATTERN = [true, false, true, true, true, false, true, false, false, false, false];
  const looks = (get: (i: number) => boolean, from: number): boolean =>
    PATTERN.every((want, i) => get(from + i) === want);
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + PATTERN.length <= size; b++) {
      if (looks((i) => grid[a]![i]!, b)) score += 40;
      if (looks((i) => grid[i]![a]!, b)) score += 40;
    }
  }

  let dark = 0;
  for (const row of grid) for (const cell of row) if (cell) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// ---------------------------------------------------------------------------

export interface Qr {
  /** `true` is dark. Square, and WITHOUT the quiet zone — the renderer adds it. */
  modules: boolean[][];
  version: number;
  /** Side length in modules, excluding the quiet zone. */
  size: number;
}

/**
 * Encode text as a QR symbol, picking the smallest version it fits in.
 *
 * Throws rather than truncating. A QR that encodes half a URL scans perfectly and sends somebody
 * to the wrong place, which is worse than one that was never built.
 */
export function encode(text: string): Qr {
  const upper = text.toUpperCase();
  const spec = VERSIONS.find((v) => upper.length <= v.capacity);
  if (!spec) throw new Error(`${upper.length} characters exceeds ${MAX_CAPACITY}, the version 6 ceiling`);

  const codewords = codewordsFor(upper, spec);

  let best: boolean[][] | undefined;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = buildMatrix(spec, codewords, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { modules: best!, version: spec.version, size: spec.version * 4 + 17 };
}

/**
 * The quiet zone, which is not optional and is not decoration.
 *
 * Four modules of light on every side. A scanner needs it to find the symbol's edges at all, and
 * a QR built out of blocks on open ground has whatever the world is made of pressed against it —
 * so here the quiet zone has to be BUILT, in the light block, rather than left to the terrain.
 */
export const QUIET = 4;

/** Side length in blocks once the quiet zone is included. */
export function footprint(qr: Qr): number {
  return qr.size + QUIET * 2;
}
