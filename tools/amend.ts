/**
 * `bedshock amend` — recording the answers only a person can give.
 *
 * THE PROBLEM THIS SOLVES, because it is not the obvious one.
 *
 * Roughly half the battery cannot be answered by script. Which pixel rows a bar covers,
 * whether a glyph is coloured, whether four flags render, whether a shulker box came back with
 * its contents — those need a screen and a person. And getting structured data back OUT of a
 * Bedrock client is genuinely hard: there is no reliable client-side log to read, and typing a
 * base64 blob on a touch device is exactly the kind of cost that decides how much ever gets
 * tested at all.
 *
 * So nothing is exfiltrated. The person plays on whatever device they are on and answers here,
 * on a machine with a keyboard. What makes that work rather than being a glorified notes file
 * is that **the answer space is declared in the capability definition**. The probe already had
 * to say what to look for and how to tell two outcomes apart — that was the rule the whole
 * time, it was just written as prose that nothing checked. Here it is data, so an answer is
 * always one of the distinctions the probe was built to make, and the ledger can verify that
 * the verdict recorded matches what that outcome means.
 *
 * Two consequences worth naming:
 *
 * Every observed capability must offer an "I could not read it" answer. A rig that did not
 * render is not a negative result, and forcing a person to pick a real verdict for a broken
 * apparatus is how a battery starts producing confident answers to questions it never asked.
 * `bedshock validate` refuses a capability that cannot say so.
 *
 * And an answer that surprises you goes in the note. The enumerated outcomes are what the
 * probe can DISTINGUISH; the note is where the thing nobody predicted gets written down, and
 * in this project's history that has repeatedly been the useful part.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import type { Capability, Observation, Outcome, Platform } from './types.ts';
import type { Catalog } from './catalog.ts';
import { appendObservations, assertVersion, readLedger, resolve } from './ledger.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

export interface AmendOptions {
  version: string;
  api?: string;
  platform?: Platform;
  run?: string;
  /** Only these probes. */
  probes?: string[];
  /** Only this capability. */
  capability?: string;
  /** Include rows already answered on this version, to re-check them. */
  all?: boolean;
  /**
   * Include rows measured NO — the watchlist.
   *
   * Off by default, because re-asking every settled negative in every session is noise. On
   * demand, because they are the rows most worth re-asking when a new Bedrock ships, and the
   * default header says so with the exact command rather than leaving it to be remembered.
   */
  negative?: boolean;
}

/**
 * Which rows are worth asking about.
 *
 * By default: observed capabilities that this version has no usable answer for. An INCONCLUSIVE
 * row counts as unanswered, because it is — it recorded that the apparatus failed, not what the
 * game does.
 *
 * A row whose dependency is unsettled is offered LAST and flagged, rather than hidden. It might
 * be exactly what someone is in-game to check, and the flag is the useful part: knowing that
 * whatever you see may be the instrument rather than the game is the difference between a
 * measurement and a session wasted.
 */
export function selectForAmendment(catalog: Catalog, observations: Observation[], opts: AmendOptions): Capability[] {
  let caps = catalog.capabilities.filter((c) => c.method === 'observed');
  if (opts.capability) caps = caps.filter((c) => c.id === opts.capability);
  if (opts.probes?.length) caps = caps.filter((c) => c.probe && opts.probes!.includes(c.probe));
  if (!opts.all) {
    caps = caps.filter((c) => {
      const s = resolve(c, opts.version, observations);
      if (s.status === 'CLOSED-NEGATIVE') return Boolean(opts.negative);
      return s.inherited || s.status === 'OPEN' || s.status === 'INCONCLUSIVE' || s.status === 'DRIFT';
    });
  }

  const blocked = (c: Capability): boolean =>
    (c.depends_on ?? []).some((d) => {
      const dep = catalog.byId.get(d);
      return !dep || resolve(dep, opts.version, observations).status !== 'SETTLED';
    });

  // Stable, and dependency-free rows first, so a session naturally works bottom-up through a
  // bisect chain rather than starting at the top and finding it unreadable.
  return [...caps].sort((a, b) => Number(blocked(a)) - Number(blocked(b)) || a.id.localeCompare(b.id));
}

function wrap(text: string, width = 76, indent = '  '): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

async function askOne(
  rl: Interface,
  cap: Capability,
  index: number,
  total: number,
  catalog: Catalog,
  observations: Observation[],
  opts: AmendOptions,
): Promise<Observation | 'skip' | 'quit'> {
  const outcomes = cap.outcomes ?? [];

  stdout.write(`\n${DIM}${'─'.repeat(78)}${RESET}\n`);
  stdout.write(`${BOLD}[${index}/${total}] ${CYAN}${cap.id}${RESET}`);
  if (cap.legacy) stdout.write(`  ${DIM}(${cap.legacy})${RESET}`);
  stdout.write('\n\n');
  stdout.write(`${wrap(cap.question, 76, '  ')}\n\n`);

  for (const depId of cap.depends_on ?? []) {
    const dep = catalog.byId.get(depId);
    if (!dep) continue;
    const s = resolve(dep, opts.version, observations);
    if (s.status !== 'SETTLED') {
      stdout.write(
        `${YELLOW}  ! rests on ${depId}, which is ${s.status} on ${opts.version}.\n` +
          `    Whatever you see here may be the instrument rather than the game.${RESET}\n\n`,
      );
    }
  }

  stdout.write(`${DIM}  Decides:${RESET}\n${DIM}${wrap(cap.decides, 74, '    ')}${RESET}\n\n`);
  if (cap.look_at) stdout.write(`${BOLD}  Look at:${RESET}\n${wrap(cap.look_at, 74, '    ')}\n\n`);

  outcomes.forEach((o, i) => {
    stdout.write(`  ${BOLD}${i + 1})${RESET} ${o.label}  ${DIM}[${o.verdict}]${RESET}\n`);
    if (o.means) stdout.write(`${DIM}${wrap(o.means, 70, '       ')}${RESET}\n`);
  });
  stdout.write(`  ${BOLD}s)${RESET} skip — did not look\n  ${BOLD}q)${RESET} stop here (everything so far is kept)\n\n`);

  let picked: Outcome | undefined;
  while (!picked) {
    const answer = (await rl.question('  > ')).trim().toLowerCase();
    if (answer === 'q') return 'quit';
    if (answer === 's' || answer === '') return 'skip';
    const n = parseInt(answer, 10);
    if (n >= 1 && n <= outcomes.length) picked = outcomes[n - 1];
    else stdout.write(`${YELLOW}  pick 1-${outcomes.length}, or s to skip, or q to stop.${RESET}\n`);
  }

  const note = (await rl.question(`  ${DIM}note (anything you saw that the options do not cover) >${RESET} `)).trim();

  stdout.write(
    `  ${DIM}recorded:${RESET} ${BOLD}${picked.verdict}${RESET} ` +
      `${DIM}(${picked.id}, observed, ${opts.platform ?? 'client'} ${opts.version})${RESET}\n`,
  );

  return {
    capability: cap.id,
    version: opts.version,
    ...(opts.api ? { api: opts.api } : {}),
    platform: opts.platform ?? 'client',
    method: 'observed',
    verdict: picked.verdict,
    outcome: picked.id,
    evidence: picked.label,
    ...(note ? { note } : {}),
    run: opts.run ?? `amend-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    at: new Date().toISOString(),
  };
}

export async function amend(catalog: Catalog, opts: AmendOptions): Promise<Observation[]> {
  assertVersion(opts.version);
  const observations = readLedger();
  const due = selectForAmendment(catalog, observations, opts);

  const negatives = catalog.capabilities.filter(
    (c) => c.method === 'observed' && resolve(c, opts.version, observations).status === 'CLOSED-NEGATIVE',
  );

  if (due.length === 0) {
    stdout.write(
      `\nNothing needs your eyes on ${opts.version}.\n` +
        `${DIM}Every observed capability already has an answer there. ` +
        `Use --all to re-check them anyway.${RESET}\n\n`,
    );
    if (negatives.length && !opts.negative) {
      stdout.write(
        `${negatives.length} row(s) are measured ${BOLD}NO${RESET} here — the watchlist.\n` +
          `${DIM}Those are the ones worth re-checking on a Bedrock you have not looked at yet:\n` +
          `  bedshock amend --version ${opts.version} --negative${RESET}\n\n`,
      );
    }
    return [];
  }

  stdout.write(
    `\n${BOLD}bedshock amend${RESET} ${DIM}·${RESET} Bedrock ${BOLD}${opts.version}${RESET} ` +
      `${DIM}·${RESET} ${due.length} row(s) need your eyes\n` +
      `${DIM}Install the battery pack, run /scriptevent bedshock:probe, and answer from what you see.\n` +
      `Nothing here is guessed for you — an answer nobody looked at is worse than an empty cell.${RESET}\n`,
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const recorded: Observation[] = [];
  try {
    for (let i = 0; i < due.length; i++) {
      const result = await askOne(rl, due[i]!, i + 1, due.length, catalog, observations, opts);
      if (result === 'quit') break;
      if (result === 'skip') continue;
      recorded.push(result);
    }
  } finally {
    rl.close();
  }

  appendObservations(recorded);
  stdout.write(
    `\n${DIM}${'─'.repeat(78)}${RESET}\n` +
      `${BOLD}${recorded.length}${RESET} observation(s) appended to the ledger.\n` +
      `${DIM}Run \`bedshock report\` to regenerate the documents.${RESET}\n\n`,
  );
  return recorded;
}
