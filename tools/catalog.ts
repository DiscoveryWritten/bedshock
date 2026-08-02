/**
 * Loading and validating the capability definitions.
 *
 * The validation here is not schema-checking for its own sake. Every rule below corresponds
 * to a way a battery can quietly stop measuring what it thinks it measures, and most of them
 * are rules the host repository learned the expensive way and then wrote down as prose that
 * nothing enforced.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import type { Capability, CapabilityFile } from './types.ts';
import { CATALOG_DIR } from './paths.ts';

export interface Catalog {
  capabilities: Capability[];
  byId: Map<string, Capability>;
  byDomain: Map<string, { about?: string; capabilities: Capability[] }>;
  /** Probe id -> the capabilities it reports. */
  byProbe: Map<string, Capability[]>;
}

const ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export function validateCapabilities(files: CapabilityFile[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const all: Capability[] = [];

  for (const file of files) {
    if (!file.domain) problems.push('a capability file has no `domain`');
    if (!Array.isArray(file.capabilities)) {
      problems.push(`${file.domain}: \`capabilities\` must be a list`);
      continue;
    }
    for (const cap of file.capabilities) {
      all.push(cap);
      const where = `${file.domain}/${cap.id ?? '<no id>'}`;

      if (!cap.id) problems.push(`${where}: no id`);
      else if (!ID_PATTERN.test(cap.id)) {
        problems.push(`${where}: id must be dotted lower_snake, e.g. item.max_durability.int16_ceiling`);
      } else if (!cap.id.startsWith(`${file.domain}.`)) {
        problems.push(`${where}: id must start with its domain, "${file.domain}."`);
      }

      if (cap.id && seen.has(cap.id)) {
        problems.push(`${where}: duplicate id, also in ${seen.get(cap.id)}`);
      } else if (cap.id) {
        seen.set(cap.id, file.domain);
      }

      if (!cap.question) problems.push(`${where}: no question`);
      // Enforced rather than encouraged. A capability with no decision behind it is one
      // nobody will read the result of, and the host repo's own rule for adding a probe led
      // with exactly this. Prose could not stop a row being added anyway.
      if (!cap.decides) problems.push(`${where}: no \`decides\` — say which decision this blocks`);

      if (cap.method === 'observed') {
        if (!cap.outcomes?.length) {
          problems.push(`${where}: an observed capability must enumerate its \`outcomes\``);
        } else {
          const ids = new Set<string>();
          for (const o of cap.outcomes) {
            if (!o.id) problems.push(`${where}: an outcome has no id`);
            else if (ids.has(o.id)) problems.push(`${where}: duplicate outcome id "${o.id}"`);
            ids.add(o.id);
            if (!o.label) problems.push(`${where}: outcome "${o.id}" has no label`);
            if (!['YES', 'NO', 'INCONCLUSIVE'].includes(o.verdict)) {
              problems.push(`${where}: outcome "${o.id}" has verdict "${o.verdict}"`);
            }
          }
          // The answer space has to be able to say "I could not tell." Without it the person
          // answering is forced to pick a real verdict for a rig that did not render, and a
          // guessed observation is worse than no answer — which is the failure that cost the
          // P3b rig two sessions before the differential reading was introduced.
          if (!cap.outcomes.some((o) => o.verdict === 'INCONCLUSIVE')) {
            problems.push(
              `${where}: no outcome with verdict INCONCLUSIVE — every observed capability needs ` +
                `an "I could not read it" answer, or a broken rig gets recorded as a finding`,
            );
          }
          if (!cap.outcomes.some((o) => o.verdict === 'YES') || !cap.outcomes.some((o) => o.verdict === 'NO')) {
            problems.push(
              `${where}: the outcomes cannot distinguish YES from NO — a probe that can only ` +
                `come back one way is not measuring anything`,
            );
          }
        }
        if (!cap.look_at) problems.push(`${where}: an observed capability must say what to \`look_at\``);
        if (!cap.probe) problems.push(`${where}: an observed capability must name its \`probe\``);
      } else {
        if (cap.outcomes) problems.push(`${where}: only observed capabilities take \`outcomes\``);
        if (cap.look_at) problems.push(`${where}: only observed capabilities take \`look_at\``);
      }

      if (cap.method === 'automated' && !cap.probe) {
        problems.push(`${where}: an automated capability must name its \`probe\``);
      }
      if (cap.method === 'derived') {
        if (!cap.established_by) {
          problems.push(`${where}: a derived capability must say what \`established_by\` it`);
        }
        if (cap.probe) problems.push(`${where}: a derived capability has no probe`);
      }
      if (!['automated', 'observed', 'derived'].includes(cap.method)) {
        problems.push(`${where}: method must be automated, observed or derived`);
      }
    }
  }

  // Dependencies, checked after every id is known.
  for (const cap of all) {
    for (const dep of cap.depends_on ?? []) {
      if (!seen.has(dep)) problems.push(`${cap.id}: depends_on "${dep}", which is not a capability`);
      if (dep === cap.id) problems.push(`${cap.id}: depends on itself`);
    }
  }
  for (const cap of all) {
    if (hasCycle(cap.id, all)) problems.push(`${cap.id}: dependency cycle`);
  }

  return problems;
}

function hasCycle(start: string, all: Capability[]): boolean {
  const edges = new Map(all.map((c) => [c.id, c.depends_on ?? []]));
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return false;
}

export function loadCatalog(dir = CATALOG_DIR): Catalog {
  const files: CapabilityFile[] = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => parse(readFileSync(join(dir, f), 'utf8')) as CapabilityFile);

  const problems = validateCapabilities(files);
  if (problems.length) {
    throw new Error(`capability definitions are invalid:\n  ${problems.join('\n  ')}`);
  }

  const capabilities = files.flatMap((f) => f.capabilities);
  const byDomain = new Map(
    files.map((f) => [f.domain, { ...(f.about ? { about: f.about } : {}), capabilities: f.capabilities }]),
  );
  const byProbe = new Map<string, Capability[]>();
  for (const cap of capabilities) {
    if (!cap.probe) continue;
    const list = byProbe.get(cap.probe) ?? [];
    list.push(cap);
    byProbe.set(cap.probe, list);
  }

  return { capabilities, byId: new Map(capabilities.map((c) => [c.id, c])), byDomain, byProbe };
}
