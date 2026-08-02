/**
 * `bedshock check` — the build-time assertion, and the reason this is a dev-time dependency
 * rather than a document.
 *
 * A pack cites a capability in its own source:
 *
 *     /** @requires bedshock:item.max_durability.int16_ceiling *​/
 *     const PACKED_MAX = 32767;
 *
 * and its build runs `bedshock check --requires-from 'packs/**​/*.ts' --version 1.21.120`,
 * where that version is the pack's own `min_engine_version`. The check fails if a cited
 * capability is not settled at or below that floor.
 *
 * WHY THIS IS WORTH A BUILD STEP. The document this battery grew out of had a rule: an OPEN
 * row is a guess no matter how confident the surrounding prose sounds, so do not build on one.
 * That rule was obeyed by reading. Twice, a design came to rest on a capability nobody had
 * measured — once on an orientation chain that checked out at every link on paper and still
 * drew wrong, once on a creative-menu sort whose own comment marked its mechanism unconfirmed.
 * Neither was caught by review, because a citation and a guess look identical in a diff.
 *
 * The check turns that into a failing build. Not because the assertion is clever, but because
 * it is the only form of the rule that survives someone being in a hurry.
 *
 * THE FLOOR IS THE THING BEING CHECKED, and the asymmetry matters. A capability measured on
 * 1.26.30 says nothing about a pack that declares it runs on 1.21.120 — the newer engine is
 * exactly where a thing that did not used to work starts working. So evidence only ever
 * inherits DOWNWARD to a later version, never upward to an earlier one, and a pack that wants
 * to use a capability its floor cannot prove has to raise its floor or carry a fallback.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { glob } from 'node:fs/promises';

import type { Observation } from './types.ts';
import type { Catalog } from './catalog.ts';
import { resolveWithDeps } from './ledger.ts';

export interface Citation {
  id: string;
  file: string;
  line: number;
}

/**
 * `@requires bedshock:<id>` anywhere in a file — comment syntax is deliberately not enforced,
 * so this works in TypeScript, JSON5, YAML, Markdown and shell alike.
 */
const CITATION = /@requires\s+bedshock:([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)/g;

export function citationsIn(source: string, file: string): Citation[] {
  const out: Citation[] = [];
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CITATION)) out.push({ id: m[1]!, file, line: i + 1 });
  });
  return out;
}

export async function collectCitations(patterns: string[], cwd = process.cwd()): Promise<Citation[]> {
  const out: Citation[] = [];
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd })) {
      const path = typeof entry === 'string' ? entry : String(entry);
      let source: string;
      try {
        source = readFileSync(path.startsWith('/') ? path : `${cwd}/${path}`, 'utf8');
      } catch {
        continue;
      }
      out.push(...citationsIn(source, relative(cwd, path.startsWith('/') ? path : `${cwd}/${path}`)));
    }
  }
  return out;
}

export interface CheckProblem {
  citation: Citation;
  severity: 'error' | 'warning';
  message: string;
}

export interface CheckResult {
  citations: Citation[];
  problems: CheckProblem[];
  ok: boolean;
}

export function checkCitations(
  citations: Citation[],
  catalog: Catalog,
  observations: Observation[],
  version: string,
): CheckResult {
  const problems: CheckProblem[] = [];

  for (const citation of citations) {
    const cap = catalog.byId.get(citation.id);
    if (!cap) {
      problems.push({
        citation,
        severity: 'error',
        message:
          `no such capability. Either it was renamed — ids are a public interface and renaming ` +
          `one is a breaking change — or this citation was written from memory.`,
      });
      continue;
    }

    // Derived rows are established by reading what the engine does rather than by a probe, and
    // do not vary per version in any way this battery could detect. Citing one is legitimate.
    if (cap.method === 'derived') continue;

    const status = resolveWithDeps(cap, version, observations, catalog);

    switch (status.status) {
      case 'SETTLED':
        if (status.inherited) {
          problems.push({
            citation,
            severity: 'warning',
            message:
              `settled on ${status.measuredAt}, not re-checked on ${version}. That is evidence, ` +
              `not a measurement — run the battery on ${version} to close the gap.`,
          });
        }
        break;

      case 'CLOSED-NEGATIVE':
        problems.push({
          citation,
          severity: 'error',
          message:
            `measured, and the answer is NO on ${status.measuredAt ?? version}. ` +
            `Something here is resting on a capability the game does not have.`,
        });
        break;

      case 'OPEN':
        problems.push({
          citation,
          severity: 'error',
          message:
            `never measured at or below ${version}. This is a guess, however confident the code ` +
            `around it looks. Run the battery, or carry a fallback and stop citing it.`,
        });
        break;

      case 'INCONCLUSIVE':
        problems.push({
          citation,
          severity: 'error',
          message:
            `the last run could not decide — the apparatus failed rather than the game answering. ` +
            `Not a soft yes. Fix the probe and re-run.`,
        });
        break;

      case 'DRIFT':
        problems.push({
          citation,
          severity: 'error',
          message: `RECORDED ANSWER NO LONGER HOLDS: ${status.conflict}`,
        });
        break;

      case 'UNDERMINED':
        problems.push({
          citation,
          severity: 'warning',
          message:
            `${status.conflict}. The measurement may have been reading the instrument rather ` +
            `than the game.`,
        });
        break;
    }
  }

  return { citations, problems, ok: !problems.some((p) => p.severity === 'error') };
}

export function formatCheckResult(result: CheckResult, version: string): string {
  const lines: string[] = [];
  const errors = result.problems.filter((p) => p.severity === 'error');
  const warnings = result.problems.filter((p) => p.severity === 'warning');

  for (const p of result.problems) {
    const tag = p.severity === 'error' ? 'FAIL' : 'warn';
    lines.push(`${tag} ${p.citation.file}:${p.citation.line}`);
    lines.push(`     @requires bedshock:${p.citation.id}`);
    lines.push(`     ${p.message}`);
    lines.push('');
  }

  const cited = new Set(result.citations.map((c) => c.id)).size;
  lines.push(
    `${result.citations.length} citation(s) of ${cited} capability(s), checked against Bedrock ${version}: ` +
      `${errors.length} failing, ${warnings.length} warning(s).`,
  );
  if (result.citations.length === 0) {
    lines.push(
      'No citations found. If that is a surprise, check the --requires-from patterns: a check ' +
        'that silently matches no files reports success forever.',
    );
  }
  return lines.join('\n');
}
