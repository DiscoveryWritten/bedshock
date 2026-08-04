/**
 * The QR encoder, checked by implementations that are not it.
 *
 * THIS IS THE ONLY KIND OF TEST WORTH HAVING HERE. A QR encoder fails silently by construction:
 * every structural property can be correct — finder patterns, timing, alignment, format bits,
 * mask, data placement — and the symbol still not decode. There is no assertion you can write
 * about the matrix's shape that would have caught any of the three real bugs this file found.
 *
 * All three were invisible to self-checking, and one of them was self-checking:
 *
 *   THE DARK MODULE was being overwritten by the second format copy, because that copy was given
 *   eight bits up the left column instead of seven. Reading the format back out with the same
 *   wrong layout it was written with returned a perfectly valid format string. The instrument
 *   agreed with itself.
 *
 *   THE GENERATOR POLYNOMIAL came out ascending with its monic term, and the division wanted it
 *   descending without. Error-correction codewords were wrong; nothing structural could see it.
 *
 *   THE FORMAT BITS were written least-significant first. Also self-consistent. Also undecodable.
 *
 * So: `jsqr` reads what we produce, and `qrcode` produces what we compare against. Two separate
 * codebases, neither sharing an assumption with ours.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import jsQR from 'jsqr';
import QRCode from 'qrcode';

import { join } from 'node:path';

import { encode, footprint, MAX_CAPACITY, QUIET } from '../pack/scripts/qr.ts';
import { ROOT } from './paths.ts';

/** Render a matrix the way the renderer does — quiet zone included — and hand it to a scanner. */
function scan(text: string): string | null {
  const qr = encode(text);
  const side = footprint(qr);
  const SCALE = 6;
  const px = side * SCALE;
  const data = new Uint8ClampedArray(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const row = Math.floor(y / SCALE) - QUIET;
      const col = Math.floor(x / SCALE) - QUIET;
      const dark = row >= 0 && col >= 0 && row < qr.size && col < qr.size && qr.modules[row]![col]!;
      const value = dark ? 0 : 255;
      const at = (y * px + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  const found = jsQR(data, px, px);
  return found ? found.data : null;
}

const PAYLOADS = [
  'A',
  'HELLO WORLD',
  '0123456789',
  '$%*+-./: TEST',
  // The real shape: a URL carrying an answer code, at both ends of the length range.
  'HTTPS://TILIV.GITHUB.IO/BEDSHOCK/R/ABCD-EFGH-JKMN',
  'HTTPS://TILIV.GITHUB.IO/BEDSHOCK/R/ABCD-EFGH-JKMN-PQRS-TVWX-YZ01',
  `HTTPS://TILIV.GITHUB.IO/BEDSHOCK/R/${'AB12-'.repeat(9).slice(0, -1)}`,
  'Z'.repeat(MAX_CAPACITY),
];

/**
 * The payload a REAL full session produces, which is the one that matters.
 *
 * The first cut of this encoder stopped at version 6 — 106 characters — and every payload anyone
 * had thought to try was short. A complete session is 35 eyes-only answers, a 77-character code,
 * and 112 characters of URL around it. It would have worked in testing and failed the first time
 * somebody answered everything, on their screen, with no way to tell why.
 */
const REAL_SESSION_URL = `HTTPS://TILIV.GITHUB.IO/BEDSHOCK/R/${'1'.repeat(77)}`;

test('a full session\'s URL fits, and scans', () => {
  assert.ok(REAL_SESSION_URL.length <= MAX_CAPACITY, `${REAL_SESSION_URL.length} > ${MAX_CAPACITY}`);
  assert.equal(scan(REAL_SESSION_URL), REAL_SESSION_URL);
});

test('every payload round-trips through an independent decoder', () => {
  for (const payload of [...PAYLOADS, REAL_SESSION_URL]) {
    assert.equal(scan(payload), payload, `jsqr could not read our symbol for ${JSON.stringify(payload)}`);
  }
});

/**
 * And byte-identical to a reference encoder, with the mask forced so the comparison is meaningful.
 *
 * Round-tripping proves the symbol is READABLE. This proves it is the symbol the specification
 * calls for, which is a stronger claim and the one that keeps holding when a scanner is fussier
 * than jsqr — a phone camera at an angle, in Minecraft's lighting, off a screen.
 */
test('the matrix matches a reference implementation exactly', () => {
  for (const payload of [...PAYLOADS, REAL_SESSION_URL]) {
    const mine = encode(payload);
    // The reference has to be told the mask, because two encoders may legitimately choose
    // different ones. Which mask we pick is a quality question; which modules result is not.
    const chosen = maskOf(mine.modules, mine.size);
    // THE MODE IS FORCED, because the reference optimises and we do not. A digits-only payload
    // makes any sensible encoder reach for numeric mode, which is denser and produces a
    // completely different — equally valid — symbol. We always use alphanumeric, so the
    // comparison has to hold that constant or it is comparing two right answers.
    const reference = QRCode.create([{ data: payload, mode: 'alphanumeric' }] as never, {
      errorCorrectionLevel: 'Q',
      maskPattern: chosen as never,
    });
    assert.equal(reference.modules.size, mine.size, `version mismatch for ${JSON.stringify(payload)}`);
    let differing = 0;
    for (let row = 0; row < mine.size; row++) {
      for (let col = 0; col < mine.size; col++) {
        if (!!reference.modules.get(row, col) !== mine.modules[row]![col]) differing++;
      }
    }
    assert.equal(differing, 0, `${differing} modules differ from the reference for ${JSON.stringify(payload)}`);
  }
});

/** The published format strings for level Q, read back out of the symbol. */
const FORMAT_Q = [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed];

function maskOf(modules: boolean[][], size: number): number {
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let bit: boolean;
    if (i < 6) bit = modules[8]![i]!;
    else if (i === 6) bit = modules[8]![7]!;
    else if (i === 7) bit = modules[8]![8]!;
    else if (i === 8) bit = modules[7]![8]!;
    else bit = modules[14 - i]![8]!;
    if (bit) bits |= 1 << (14 - i);
  }
  const mask = FORMAT_Q.indexOf(bits);
  assert.ok(mask >= 0, `format bits ${bits.toString(16)} are not a valid level-Q format string`);
  void size;
  return mask;
}

/**
 * The dark module is always set, and it is not part of the format.
 *
 * Its own test because overwriting it was one of the three bugs, and because it is the single
 * module whose value is fixed by the specification regardless of content, version or mask — so a
 * symbol that gets it wrong is wrong no matter what else is right.
 */
test('the dark module is dark, in every version', () => {
  for (const payload of PAYLOADS) {
    const qr = encode(payload);
    assert.equal(qr.modules[qr.size - 8]![8], true, `dark module unset for ${JSON.stringify(payload)}`);
  }
});

/** Both format copies have to say the same thing, or a scanner reading either gets a different mask. */
test('the two format copies agree', () => {
  for (const payload of PAYLOADS) {
    const qr = encode(payload);
    const first = maskOf(qr.modules, qr.size);
    let bits = 0;
    for (let i = 0; i < 15; i++) {
      const bit = i < 7 ? qr.modules[qr.size - 1 - i]![8]! : qr.modules[8]![qr.size - 15 + i]!;
      if (bit) bits |= 1 << (14 - i);
    }
    assert.equal(FORMAT_Q.indexOf(bits), first, `the two format copies disagree for ${JSON.stringify(payload)}`);
  }
});

/**
 * A payload that does not fit must THROW rather than be truncated.
 *
 * A QR encoding half a URL scans perfectly and sends somebody somewhere else, which is worse than
 * one that was never built — the failure arrives at a stranger's phone rather than in a log.
 */
test('an over-long payload is refused rather than cut short', () => {
  assert.throws(() => encode('Z'.repeat(MAX_CAPACITY + 1)), /exceeds/);
});

test('a character outside the alphanumeric alphabet is refused', () => {
  assert.throws(() => encode('lower case is fine, but a comma, is not'), /alphanumeric/);
});

/**
 * The footprint has to stay something a person can photograph in one shot.
 *
 * This is rendered as terrain and read from above; a symbol that needs the player sixty blocks up
 * to fit in frame is one where individual modules stop being distinguishable.
 */
test('the largest symbol still fits in a reasonable square of ground', () => {
  const biggest = encode('Z'.repeat(MAX_CAPACITY));
  assert.ok(footprint(biggest) <= 56, `${footprint(biggest)} blocks square is too big to photograph`);
  assert.equal(footprint(biggest), biggest.size + QUIET * 2);
});

// ---------------------------------------------------------------------------
// The other end
// ---------------------------------------------------------------------------

/**
 * The QR has to point at a page that exists.
 *
 * A code somebody scans and lands on a 404 has wasted their whole session — worse than no QR at
 * all, because they believe they reported something. The URL in `session.ts` and the path the
 * site is served from are two facts in two files with nothing but this connecting them.
 */
test('the URL the QR carries matches where the page is served from', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const session = readFileSync(join(ROOT, 'pack', 'scripts', 'session.ts'), 'utf8');
  const url = /REPORT_URL = '([^']+)'/.exec(session)?.[1];
  assert.ok(url, 'no REPORT_URL in session.ts');
  assert.match(url, /^HTTPS:\/\//, 'the QR payload must be uppercase — alphanumeric mode has no lowercase');

  // `https://tiliv.github.io/bedshock/r/` is served from `site/r/index.html`.
  const path = url.toLowerCase().replace(/^https:\/\/[^/]+\/bedshock\//, '').replace(/\/$/, '');
  assert.ok(
    existsSync(join(ROOT, 'site', path, 'index.html')),
    `the QR points at /${path}/ but site/${path}/index.html does not exist`,
  );
});

/** Every character of the URL prefix has to be encodable, or no session can ever build a QR. */
test('the report URL is entirely inside the alphanumeric alphabet', async () => {
  const { readFileSync } = await import('node:fs');
  const session = readFileSync(join(ROOT, 'pack', 'scripts', 'session.ts'), 'utf8');
  const url = /REPORT_URL = '([^']+)'/.exec(session)![1]!;
  assert.doesNotThrow(() => encode(url + 'ABCD'), 'the report URL cannot be encoded at all');
});
