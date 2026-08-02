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
  anvilgap: {
    block: string;
    obstruction: string;
    plane_height: number;
    drop_height: number;
    vacate_ticks: number;
    watch_ticks: number;
    repeats: number;
    max_trials: number;
  };
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
  // A solve is only as good as the room it has to move in. The anvil has to start clear of the
  // obstruction, and the obstruction has to be somewhere a trial can put it.
  const a = p.anvilgap;
  if (a) {
    if (a.drop_height < 2) {
      problems.push('probes.anvilgap.drop_height under 2 leaves the anvil no room to accelerate before the plane');
    }
    if (a.plane_height < 1) {
      problems.push('probes.anvilgap.plane_height must be at least 1, or the obstruction sits in the floor');
    }
    // The anvil falls at well under a block a tick for the first second. A window shorter than
    // the fall settles every trial as "neither outcome observed", which reads as an apparatus
    // failure on a perfectly good apparatus.
    if (a.watch_ticks < a.drop_height * 8) {
      problems.push(
        `probes.anvilgap.watch_ticks (${a.watch_ticks}) is short for a ${a.drop_height}-block drop — ` +
          'Bedrock gravity is about 0.33 blocks/tick after ten ticks, so allow at least 8 ticks a block',
      );
    }
    if (a.repeats < 1) problems.push('probes.anvilgap.repeats below 1 means no trial is ever run');
    // Zero ticks out of the way is no window at all: the block leaves and returns in the same
    // tick, nothing ever gets through, and every trial reports caught. That reads as a game that
    // never lets anything pass, which is a statement about the probe.
    if (a.vacate_ticks < 1) {
      problems.push('probes.anvilgap.vacate_ticks below 1 leaves no window for anything to pass through');
    }
    // And a window longer than the fall means the block is still away when the anvil arrives at
    // every clearance, so nothing is ever caught and the search has no tight bound.
    if (a.vacate_ticks >= a.watch_ticks) {
      problems.push(
        `probes.anvilgap.vacate_ticks (${a.vacate_ticks}) is not shorter than the whole watch ` +
          `window, so the obstruction never returns and no trial can fail`,
      );
    }
    // Two bound checks plus the halvings, times the repeats. A ceiling under that turns every
    // run into "ran out of trials", which reports as INCONCLUSIVE and looks like a broken game.
    if (a.max_trials < (2 + 6) * Math.max(1, a.repeats)) {
      problems.push(
        `probes.anvilgap.max_trials (${a.max_trials}) is below what two bound checks and six ` +
          `halvings cost at ${a.repeats} repeat(s); the solve would run out before it converged`,
      );
    }
  }

  const ids = (p.menu_variants ?? []).map((v) => v.id);
  if (new Set(ids).size !== ids.length) problems.push('probes.menu_variants has a duplicate id');
  const cids = (p.containers ?? []).map((v) => v.id);
  if (new Set(cids).size !== cids.length) problems.push('probes.containers has a duplicate id');

  return problems;
}
