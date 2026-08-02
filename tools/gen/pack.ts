/**
 * Emitting the probe pack.
 *
 * Everything here is an instrument. There is no gameplay, no balance and no art direction —
 * only apparatus, and the standard an apparatus is held to is that its result cannot be read
 * two ways.
 *
 * Three rules run through all of it:
 *
 *   Every observed probe carries a CONTROL wired to a literal. When every link checks out and
 *   the rig still fails, the only thing that saves a session is knowing whether the instrument
 *   works.
 *
 *   Existence and behaviour are separate emissions. A rejected item definition is invisible on
 *   Bedrock in exactly the same way a successfully hidden one is, so anything asking about
 *   visibility gets a headless existence check underneath it.
 *
 *   Nothing is offset by zero. An attachable's anchor is on the body, so probe geometry placed
 *   at the anchor renders perfectly and is occluded by the player — a failure this apparatus
 *   has already been repaired for twice.
 */

import type { ContainerVariant, PackConfig } from '../config.ts';
import { flipbookStrip, glyphChar, glyphPage, ringSprite, rulerSprite, solid } from './assets.ts';

export interface OutFile {
  path: string;
  data: string | Buffer;
}

const j = (o: unknown): string => JSON.stringify(o, null, 2) + '\n';

/** Every probe id and texture key is prefixed, so one grep finds all of them. */
export const PREFIX = 'probe';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export function probeIds(c: PackConfig) {
  const ns = c.namespace;
  const p = c.probes;
  return {
    durability: p.durability.ceilings.map((declared) => ({
      declared,
      id: `${ns}:${PREFIX}_dur_${declared}`,
    })),
    ruler: `${ns}:${PREFIX}_ruler`,
    glyph: `${ns}:${PREFIX}_glyph`,
    dynprop: `${ns}:${PREFIX}_dynprop`,
    offhand_custom: `${ns}:${PREFIX}_offhand_ok`,
    flipbook: [`${ns}:${PREFIX}_flip_a`, `${ns}:${PREFIX}_flip_b`],
    menu: p.menu_variants.map((v) => ({ ...v, id: `${ns}:${PREFIX}_menu_${v.id}` })),
    containers: p.containers.map((v) => ({ ...v, id: `${ns}:${PREFIX}_box_${v.id}` })),
  };
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function manifests(c: PackConfig): OutFile[] {
  const header = (uuid: string, suffix: string) => ({
    format_version: 2,
    header: {
      name: `${c.name}${suffix}`,
      description: c.description,
      uuid,
      version: c.version,
      min_engine_version: c.min_engine_version,
    },
  });

  const bp = {
    ...header(c.uuids.bp_header, ' (behavior)'),
    modules: [
      { type: 'data', uuid: c.uuids.bp_module, version: c.version },
      { type: 'script', language: 'javascript', entry: c.script.entry, uuid: c.uuids.bp_script, version: c.version },
    ],
    dependencies: [
      { uuid: c.uuids.rp_header, version: c.version },
      ...Object.entries(c.script.modules).map(([module_name, version]) => ({ module_name, version })),
    ],
  };

  const rp = {
    ...header(c.uuids.rp_header, ' (resource)'),
    modules: [{ type: 'resources', uuid: c.uuids.rp_module, version: c.version }],
    dependencies: [{ uuid: c.uuids.bp_header, version: c.version }],
  };

  return [
    { path: 'BP/manifest.json', data: j(bp) },
    { path: 'RP/manifest.json', data: j(rp) },
  ];
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface ItemSpec {
  id: string;
  texture: string;
  name: string;
  /** Absent means `menu_category` is omitted entirely — which is one of the variants. */
  category?: string;
  group?: string;
  maxDurability?: number;
  stackSize?: number;
  allowOffHand?: boolean;
}

function itemFile(c: PackConfig, spec: ItemSpec): OutFile {
  const components: Record<string, unknown> = {
    'minecraft:icon': spec.texture,
    'minecraft:max_stack_size': spec.stackSize ?? 1,
  };
  if (spec.maxDurability !== undefined) {
    components['minecraft:durability'] = { max_durability: spec.maxDurability };
    // `minecraft:repairable` is deliberately absent everywhere in this pack. Anything that can
    // rewrite `damage` from outside — an anvil, a grindstone, Mending — would silently corrupt
    // a value the probe is trying to read back, and a probe measuring its own contamination is
    // worse than no probe.
  }
  if (spec.allowOffHand) components['minecraft:allow_off_hand'] = true;

  const item: Record<string, unknown> = {
    format_version: c.format_versions.item,
    'minecraft:item': {
      description: {
        identifier: spec.id,
        ...(spec.category === undefined && spec.group === undefined
          ? {}
          : { menu_category: { ...(spec.category ? { category: spec.category } : {}), ...(spec.group ? { group: spec.group } : {}) } }),
      },
      components,
    },
  };
  return { path: `BP/items/${spec.id.split(':')[1]}.json`, data: j(item) };
}

function itemSpecs(c: PackConfig): ItemSpec[] {
  const ids = probeIds(c);
  const p = c.probes;
  const specs: ItemSpec[] = [];

  // P1 — one item per candidate ceiling. Any the game rejects simply will not exist, and
  // `new ItemStack` throwing is the only way to ask "did the game accept this" from in-game.
  for (const entry of ids.durability) {
    specs.push({
      id: entry.id,
      texture: `${PREFIX}_dur`,
      name: `P1 max_durability ${entry.declared}`,
      category: 'items',
      maxDurability: entry.declared,
    });
  }

  specs.push({
    id: ids.ruler,
    texture: `${PREFIX}_ruler`,
    name: 'P2 durability-bar ruler',
    category: 'items',
    maxDurability: p.ruler.max_durability,
  });

  specs.push({ id: ids.glyph, texture: `${PREFIX}_glyph`, name: 'P5 glyph carrier', category: 'items' });
  specs.push({ id: ids.dynprop, texture: `${PREFIX}_dynprop`, name: 'P8 dynamic-property carrier', category: 'items' });

  // The off-hand comparison's other arm: our own item, declaring the slot it wants. If a
  // vanilla diamond is ejected and this one is not, the ejection is about the ITEM rather than
  // about the slot — a much narrower limit than "the off-hand is out".
  specs.push({
    id: ids.offhand_custom,
    texture: `${PREFIX}_offhand`,
    name: 'P9 off-hand (declares allow_off_hand)',
    category: 'items',
    allowOffHand: true,
  });

  ids.flipbook.forEach((id, i) => {
    specs.push({ id, texture: `${PREFIX}_flip_${i === 0 ? 'a' : 'b'}`, name: `P10 flipbook spelling ${i + 1}`, category: 'items' });
  });

  for (const variant of ids.menu) {
    specs.push({
      id: variant.id,
      texture: `${PREFIX}_menu`,
      name: variant.label,
      ...(variant.category ? { category: variant.category } : {}),
      ...(variant.group ? { group: variant.group } : {}),
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * One template, one substitution.
 *
 * The `chest` and `horse` variants are identical in every component, every flag and every
 * size — only `container_type` differs. That is what makes a behavioural difference between
 * them attributable rather than a guess about which of a dozen ingredients mattered, and it is
 * why `validatePackConfig` refuses a config where the two families share no size.
 */
function containerEntity(c: PackConfig, variant: ContainerVariant & { id: string }): OutFile {
  const entity = {
    format_version: c.format_versions.entity,
    'minecraft:entity': {
      description: {
        identifier: variant.id,
        is_spawnable: false,
        is_summonable: true,
        is_experimental: false,
      },
      components: {
        'minecraft:type_family': { family: ['bedshock_probe', 'inanimate'] },
        'minecraft:collision_box': { width: 0.9, height: 0.9 },
        'minecraft:physics': {},
        'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: false },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: false }] },
        'minecraft:persistent': {},
        'minecraft:nameable': {},
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:inventory': {
          container_type: variant.container_type,
          inventory_size: variant.size,
          // `private: false` on both. A private inventory is one the player cannot open at
          // all, which would answer the interesting question by construction.
          private: false,
          can_be_siphoned_from: false,
        },
        // Carried on BOTH variants as the likeliest missing ingredient for opening. Keeping it
        // on the chest variant too is what makes its absence-of-effect measurable.
        'minecraft:is_chested': {},
      },
    },
  };
  return { path: `BP/entities/${variant.id.split(':')[1]}.json`, data: j(entity) };
}

/** A plain white cube, so the container screen's preview panel has something to draw. */
function entityClientFiles(c: PackConfig): OutFile[] {
  const ns = c.namespace;
  const ids = probeIds(c);
  const files: OutFile[] = [
    {
      path: 'RP/models/entity/probe_box.geo.json',
      data: j({
        format_version: '1.12.0',
        'minecraft:geometry': [
          {
            description: { identifier: 'geometry.probe_box', texture_width: 16, texture_height: 16, visible_bounds_width: 2, visible_bounds_height: 2 },
            bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-6, 0, -6], size: [12, 12, 12], uv: [0, 0] }] }],
          },
        ],
      }),
    },
    { path: 'RP/textures/entity/probe_box.png', data: solid(16, '#ffffff') },
    {
      path: 'RP/render_controllers/probe_box.render_controllers.json',
      data: j({
        format_version: '1.10.0',
        render_controllers: {
          'controller.render.probe_box': { geometry: 'Geometry.default', materials: [{ '*': 'Material.default' }], textures: ['Texture.default'] },
        },
      }),
    },
  ];

  for (const variant of ids.containers) {
    const key = variant.id.split(':')[1]!;
    files.push({
      path: `RP/entity/${key}.entity.json`,
      data: j({
        format_version: '1.10.0',
        'minecraft:client_entity': {
          description: {
            identifier: variant.id,
            materials: { default: 'entity_alphatest' },
            textures: { default: 'textures/entity/probe_box' },
            geometry: { default: 'geometry.probe_box' },
            render_controllers: ['controller.render.probe_box'],
          },
        },
      }),
    });
  }
  void ns;
  return files;
}

// ---------------------------------------------------------------------------
// Textures, fonts, language
// ---------------------------------------------------------------------------

function textureFiles(c: PackConfig): OutFile[] {
  const p = c.probes;
  const files: OutFile[] = [
    { path: `RP/textures/items/${PREFIX}_dur.png`, data: solid(16, '#4477aa') },
    { path: `RP/textures/items/${PREFIX}_ruler.png`, data: rulerSprite() },
    { path: `RP/textures/items/${PREFIX}_glyph.png`, data: ringSprite(16, '#ffffff') },
    { path: `RP/textures/items/${PREFIX}_dynprop.png`, data: solid(16, '#aa7744') },
    { path: `RP/textures/items/${PREFIX}_offhand.png`, data: solid(16, '#44aa77') },
    { path: `RP/textures/items/${PREFIX}_menu.png`, data: solid(16, '#aa44aa') },
    { path: `RP/textures/items/${PREFIX}_flip_a.png`, data: flipbookStrip(p.flipbook.frames) },
    { path: `RP/textures/items/${PREFIX}_flip_b.png`, data: flipbookStrip(p.flipbook.frames) },
    // Written where a form can name it and DELIBERATELY LEFT OUT of item_texture.json below.
    // Its absence from the atlas is the exact thing the form-icon probe is ruling out.
    { path: 'RP/textures/probe/icon_unindexed.png', data: solid(16, '#ffaa00') },
    { path: `RP/font/glyph_${p.glyphs.page}.png`, data: glyphPage(p.glyphs.swatches) },
  ];

  const keys = [
    `${PREFIX}_dur`, `${PREFIX}_ruler`, `${PREFIX}_glyph`, `${PREFIX}_dynprop`,
    `${PREFIX}_offhand`, `${PREFIX}_menu`, `${PREFIX}_flip_a`, `${PREFIX}_flip_b`,
  ];
  files.push({
    path: 'RP/textures/item_texture.json',
    data: j({
      resource_pack_name: c.namespace,
      texture_name: 'atlas.items',
      texture_data: Object.fromEntries(keys.map((k) => [k, { textures: `textures/items/${k}` }])),
    }),
  });

  // TWO SPELLINGS, different in every field that could plausibly be the mistake. A single
  // frozen icon cannot distinguish "item atlas tiles do not flipbook" from "this entry is
  // wrong", and that ambiguity has already cost a reading once.
  files.push({
    path: 'RP/textures/flipbook_textures.json',
    data: j([
      {
        flipbook_texture: `textures/items/${PREFIX}_flip_a`,
        atlas_tile: `${PREFIX}_flip_a`,
        ticks_per_frame: p.flipbook.ticks_per_frame,
        frames: Array.from({ length: p.flipbook.frames }, (_, i) => i),
        blend_frames: false,
      },
      {
        flipbook_texture: `textures/items/${PREFIX}_flip_b`,
        atlas_tile: `${PREFIX}_flip_b`,
        ticks_per_frame: p.flipbook.ticks_per_frame,
        blend_frames: true,
      },
    ]),
  });

  files.push({
    path: 'RP/font/font_metadata.json',
    data: j({ font_size: 16, version: 1 }),
  });

  return files;
}

function languageFiles(c: PackConfig): OutFile[] {
  const specs = itemSpecs(c);
  const ids = probeIds(c);
  const lines = [
    ...specs.map((s) => `item.${s.id}=${s.name}`),
    ...ids.containers.map((v) => `entity.${v.id}.name=P11 ${v.id.split('_box_')[1]} (${v.container_type} x${v.size})`),
    'itemGroup.name.probe_group=P7 probe group',
  ];
  return [
    { path: 'RP/texts/en_US.lang', data: lines.join('\n') + '\n' },
    { path: 'RP/texts/languages.json', data: j(['en_US']) },
    { path: 'BP/texts/en_US.lang', data: lines.join('\n') + '\n' },
    { path: 'BP/texts/languages.json', data: j(['en_US']) },
  ];
}

// ---------------------------------------------------------------------------
// The generated content module the runtime reads
// ---------------------------------------------------------------------------

/**
 * Ids and parameters, handed to the runtime as data rather than duplicated by hand.
 *
 * The runtime must never know a probe id that the generator did not emit, and the generator
 * must never emit one the runtime cannot find. Writing both from one source is the only
 * version of that guarantee which cannot drift.
 */
export function generatedModule(c: PackConfig): string {
  const ids = probeIds(c);
  const p = c.probes;
  return [
    '// GENERATED by tools/gen/pack.ts — do not edit.',
    '// Ids and apparatus parameters, so the runtime and the emitted files cannot disagree.',
    '',
    'export interface MenuId { id: string; label: string; category?: string; group?: string }',
    'export interface ContainerId { id: string; container_type: string; size: number }',
    'export interface DurabilityId { declared: number; id: string }',
    '',
    `export const NAMESPACE = ${JSON.stringify(c.namespace)};`,
    `export const PACK_VERSION = ${JSON.stringify(c.version.join('.'))};`,
    '',
    'export const IDS: {',
    '  durability: DurabilityId[];',
    '  ruler: string;',
    '  glyph: string;',
    '  dynprop: string;',
    '  offhand_custom: string;',
    '  flipbook: string[];',
    '  menu: MenuId[];',
    '  containers: ContainerId[];',
    `} = ${JSON.stringify(ids, null, 2)};`,
    '',
    `export const PARAMS = ${JSON.stringify(p, null, 2)} as const;`,
    `export const GLYPHS = ${JSON.stringify(p.glyphs.swatches.map((_, i) => glyphChar(p.glyphs.page, i)))};`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------

export function packFiles(c: PackConfig): OutFile[] {
  const ids = probeIds(c);
  return [
    ...manifests(c),
    ...itemSpecs(c).map((spec) => itemFile(c, spec)),
    ...ids.containers.map((v) => containerEntity(c, v)),
    ...entityClientFiles(c),
    ...textureFiles(c),
    ...languageFiles(c),
  ];
}
