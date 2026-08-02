/**
 * The answer code: how a session's results get out of a Minecraft client.
 *
 * THE CONSTRAINT, and it is absolute rather than an inconvenience. `@minecraft/server-net`
 * says so in its own description: *"This module can only be used on Bedrock Dedicated Server."*
 * A client add-on has no HTTP, no socket, no egress of any kind. Nothing a person plays on can
 * report anywhere. So on a device with no terminal beside it — an iPad, a console — the only
 * channel out of the game is **the screen**, and the only reader is a human or a photograph of
 * one.
 *
 * That makes the code the product of a session rather than a fallback, and it sets the design
 * targets exactly:
 *
 *   SHORT      one string per SESSION, not per answer. Nine questions come back as ~25
 *              characters, because the alternative is typing nine sentences.
 *   TYPEABLE   Crockford base32 — no I, L, O or U, so nothing is confusable with 1 or 0, and
 *              lowercase is accepted because a touch keyboard capitalises when it feels like it.
 *   GROUPED    dashes every four characters, because that is how a person reads a string back
 *              off a screenshot without losing their place.
 *   CHECKED    a checksum over the whole payload, and this one is not optional. A mistyped
 *              code that silently decoded to *different valid answers* would put fabricated
 *              measurements into the ledger, which is the precise failure this entire project
 *              exists to prevent. A code that fails to parse is free; a code that parses wrongly
 *              is poison.
 *   PINNED     the catalog revision is in the header, so a code produced by one version of the
 *              questions cannot be redeemed against another. Outcome indices are positional,
 *              and positions move when a question is edited.
 */

/**
 * Crockford base32, minus the ambiguous glyphs. `U` is excluded as well — Crockford drops it to
 * avoid accidental obscenity, and keeping the alphabet identical to a published standard means
 * a person can look up why `I` is missing rather than trusting us about it.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Decoding is forgiving where a human is likely to slip, and nowhere else. */
const NORMALISE: Record<string, string> = { O: '0', o: '0', I: '1', i: '1', L: '1', l: '1' };

export const SCHEMA = 1;

/** Bits per field. 64 capabilities and 16 outcomes each is well past what a session asks. */
const CAP_BITS = 6;
const OUTCOME_BITS = 4;
const ANSWER_BITS = CAP_BITS + OUTCOME_BITS;

export const MAX_CAPABILITIES = 1 << CAP_BITS;
export const MAX_OUTCOMES = 1 << OUTCOME_BITS;

export interface Answer {
  /** Index into the session's ordered capability list — NOT a capability id. */
  capability: number;
  /** Index into that capability's declared outcomes. */
  outcome: number;
}

export interface Payload {
  schema: number;
  /** First four hex characters of the catalog revision, without the `r`. */
  revision: string;
  answers: Answer[];
}

// ---------------------------------------------------------------------------
// Bit plumbing
// ---------------------------------------------------------------------------

function toBits(answers: Answer[]): number[] {
  const bits: number[] = [];
  for (const a of answers) {
    for (let i = CAP_BITS - 1; i >= 0; i--) bits.push((a.capability >> i) & 1);
    for (let i = OUTCOME_BITS - 1; i >= 0; i--) bits.push((a.outcome >> i) & 1);
  }
  return bits;
}

function fromBits(bits: number[]): Answer[] {
  const answers: Answer[] = [];
  for (let at = 0; at + ANSWER_BITS <= bits.length; at += ANSWER_BITS) {
    let capability = 0;
    for (let i = 0; i < CAP_BITS; i++) capability = (capability << 1) | bits[at + i]!;
    let outcome = 0;
    for (let i = 0; i < OUTCOME_BITS; i++) outcome = (outcome << 1) | bits[at + CAP_BITS + i]!;
    answers.push({ capability, outcome });
  }
  return answers;
}

function bitsToChars(bits: number[]): string {
  let out = '';
  for (let at = 0; at < bits.length; at += 5) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = (value << 1) | (bits[at + i] ?? 0);
    out += ALPHABET[value];
  }
  return out;
}

function charsToBits(chars: string): number[] {
  const bits: number[] = [];
  for (const ch of chars) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`"${ch}" is not a character this code can contain`);
    for (let i = 4; i >= 0; i--) bits.push((value >> i) & 1);
  }
  return bits;
}

/**
 * A two-character checksum over the header and body.
 *
 * Deliberately not a CRC — this runs inside the Minecraft script engine as well as here, and a
 * table-driven CRC is more code than the job needs. A position-weighted sum catches the two
 * mistakes a person actually makes off a screenshot: a wrong character, and two characters
 * swapped. A plain sum would catch the first and miss the second.
 */
export function checksum(body: string): string {
  let a = 1;
  let b = 0;
  for (let i = 0; i < body.length; i++) {
    a = (a + body.charCodeAt(i)) % 1021;
    b = (b + a) % 1021;
  }
  const value = (b * 1021 + a) % 1024;
  return ALPHABET[(value >> 5) & 31]! + ALPHABET[value & 31]!;
}

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

function group(text: string, size = 4): string {
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts.join('-');
}

export function encodeAnswers(revision: string, answers: Answer[]): string {
  const rev = revision.replace(/^r/, '').slice(0, 4).toUpperCase();
  if (rev.length !== 4) throw new Error(`"${revision}" is not a catalog revision`);
  for (const a of answers) {
    if (a.capability < 0 || a.capability >= MAX_CAPABILITIES) throw new Error(`capability index ${a.capability} out of range`);
    if (a.outcome < 0 || a.outcome >= MAX_OUTCOMES) throw new Error(`outcome index ${a.outcome} out of range`);
  }
  // The revision is hex, which base32 happens to contain — so it travels as itself and a person
  // can eyeball whether two codes came from the same questions without decoding either.
  const body = ALPHABET[SCHEMA]! + rev + bitsToChars(toBits(answers));
  return group(body + checksum(body));
}

export interface DecodeResult {
  ok: boolean;
  payload?: Payload;
  error?: string;
}

export function decodeAnswers(code: string): DecodeResult {
  const cleaned = [...code.trim()]
    .map((ch) => NORMALISE[ch] ?? ch)
    .filter((ch) => ch !== '-' && ch !== ' ')
    .join('')
    .toUpperCase();

  if (cleaned.length < 8) return { ok: false, error: 'too short to be an answer code' };

  const body = cleaned.slice(0, -2);
  const given = cleaned.slice(-2);
  const wanted = checksum(body);
  if (given !== wanted) {
    return {
      ok: false,
      error:
        `checksum ${given} does not match ${wanted}. Something was mistyped or misread — ` +
        `re-read the code rather than adjusting it. A code that decodes WRONGLY would put ` +
        `answers nobody gave into the ledger, which is worse than one that will not decode.`,
    };
  }

  const schema = ALPHABET.indexOf(body[0]!);
  if (schema !== SCHEMA) return { ok: false, error: `answer-code schema ${schema}, expected ${SCHEMA}` };

  const revision = body.slice(1, 5);
  if (revision.length !== 4) return { ok: false, error: 'no catalog revision in the code' };

  let answers: Answer[];
  try {
    answers = fromBits(charsToBits(body.slice(5)));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, payload: { schema, revision, answers } };
}
