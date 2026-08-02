/**
 * `content/pack.yaml` — the probe pack's identity and the apparatus parameters.
 *
 * Kept separate from `content/capabilities/*.yaml` because they change for different reasons.
 * A capability changes when the QUESTION changes, which should be rare and deliberate. This
 * file changes when the instrument needs adjusting — a palette that turned out to be
 * unreadable, a settle time that was too short — which is ordinary maintenance.
 *
 * Nothing in here is ever an expectation. What a probe declares belongs here; what it
 * REPORTED is a measurement and belongs in the ledger. Keeping those in two files is the
 * structural fix for the one edit that would make this whole system worthless: an expectation
 * quietly adjusted until a probe stops complaining.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import { CONTENT_DIR } from './paths.ts';

export interface MenuVariant {
  id: string;
  label: string;
  category?: string;
  group?: string;
}

export interface ContainerVariant {
  id: string;
  container_type: 'chest' | 'horse';
  size: number;
}

export interface ProbeConfig {
  durability: { ceilings: number[] };
  ruler: { max_durability: number; damage_samples: number[] };
  glyphs: { page: string; swatches: string[] };
  form_icons: { unindexed_path: string; vanilla_path: string; atlas_key: string; missing_path: string };
  menu_variants: MenuVariant[];
  flipbook: { frames: number; ticks_per_frame: number };
  containers: ContainerVariant[];
  offhand: { arbitrary_item: string; settle_ticks: number };
  falling_block: { block: string; drop_height: number; watch_ticks: number };
}

export interface PackConfig {
  namespace: string;
  name: string;
  description: string;
  version: [number, number, number];
  min_engine_version: [number, number, number];
  uuids: Record<'bp_header' | 'bp_module' | 'bp_script' | 'rp_header' | 'rp_module', string>;
  script: { entry: string; modules: Record<string, string> };
  format_versions: Record<string, string>;
  probes: ProbeConfig;
}

export function loadPackConfig(file = join(CONTENT_DIR, 'pack.yaml')): PackConfig {
  const config = parse(readFileSync(file, 'utf8')) as PackConfig;
  const problems = validatePackConfig(config);
  if (problems.length) throw new Error(`content/pack.yaml is invalid:\n  ${problems.join('\n  ')}`);
  return config;
}

export function validatePackConfig(c: PackConfig): string[] {
  const problems: string[] = [];
  if (!c.namespace?.match(/^[a-z][a-z0-9_]*$/)) problems.push('namespace must be lower_snake');
  for (const key of ['bp_header', 'bp_module', 'bp_script', 'rp_header', 'rp_module'] as const) {
    if (!c.uuids?.[key]?.match(/^[0-9a-f-]{36}$/)) problems.push(`uuids.${key} is not a UUID`);
  }
  const seen = new Set(Object.values(c.uuids ?? {}));
  if (seen.size !== 5) problems.push('the five UUIDs must all be different');

  const p = c.probes;
  if (!p) return [...problems, 'no `probes` section'];

  if (!p.durability?.ceilings?.length) problems.push('probes.durability.ceilings is empty');
  // The whole reason this probe exists is the boundary, and a ceiling list that stops below it
  // measures the uninteresting half. 32767 is 2^15-1, where a signed 16-bit field turns over.
  if (p.durability?.ceilings && !p.durability.ceilings.some((n) => n > 32767)) {
    problems.push(
      'probes.durability.ceilings has no value above 32767 — the boundary is the measurement, ' +
        'and a list that stops below it cannot tell a wrap from a clamp',
    );
  }
  if (p.glyphs?.swatches && new Set(p.glyphs.swatches).size !== p.glyphs.swatches.length) {
    problems.push('probes.glyphs.swatches has a duplicate — two identical rings answer one question twice');
  }
  if (p.flipbook && p.flipbook.frames < 2) {
    problems.push('probes.flipbook.frames must be at least 2, or there is nothing to animate');
  }
  // Single-variable comparison or nothing. If the two container types differ in anything but
  // `container_type`, a difference in behaviour cannot be attributed.
  const chest = p.containers?.filter((v) => v.container_type === 'chest') ?? [];
  const horse = p.containers?.filter((v) => v.container_type === 'horse') ?? [];
  if (!chest.length || !horse.length) {
    problems.push('probes.containers needs at least one `chest` and one `horse` variant to compare');
  } else if (!chest.some((v) => horse.some((h) => h.size === v.size))) {
    problems.push(
      'probes.containers: the chest and horse variants share no size, so any difference between ' +
        'them could be the size rather than the container type',
    );
  }
  if (p.offhand && p.offhand.settle_ticks < 20) {
    problems.push(
      'probes.offhand.settle_ticks below 20 is under a second — the client ejection is not ' +
        'instant, and reading too early reports a false persistence',
    );
  }
  const ids = (p.menu_variants ?? []).map((v) => v.id);
  if (new Set(ids).size !== ids.length) problems.push('probes.menu_variants has a duplicate id');
  const cids = (p.containers ?? []).map((v) => v.id);
  if (new Set(cids).size !== cids.length) problems.push('probes.containers has a duplicate id');

  return problems;
}
