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

import type { Capability } from '../types.ts';
import type { ContainerVariant, PackConfig } from '../config.ts';
import type { Catalog } from '../catalog.ts';
import type { Observation } from '../types.ts';
import { resolveWithDeps } from '../ledger.ts';
import { catalogRevision } from '../manifest.ts';
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
    repair: `${ns}:${PREFIX}_repair`,
    glyph: `${ns}:${PREFIX}_glyph`,
    dynprop: `${ns}:${PREFIX}_dynprop`,
    offhand_custom: `${ns}:${PREFIX}_offhand_ok`,
    flipbook: [`${ns}:${PREFIX}_flip_a`, `${ns}:${PREFIX}_flip_b`],
    menu: p.menu_variants.map((v) => ({ ...v, id: `${ns}:${PREFIX}_menu_${v.id}` })),
    containers: p.containers.map((v) => ({ ...v, id: `${ns}:${PREFIX}_box_${v.id}` })),
    // Two items for the candidate rig, differing only in damage. See the note in pack.yaml for
    // why one item cannot answer this.
    attach: [`${ns}:${PREFIX}_attach_a`, `${ns}:${PREFIX}_attach_b`],
    attach_min: `${ns}:${PREFIX}_att_min`,
    attach_pose: `${ns}:${PREFIX}_att_pose`,
    stash_carrier: p.stash.carrier,
    stash_holder: p.stash.holder,
  };
}

// ---------------------------------------------------------------------------
// The attachable
// ---------------------------------------------------------------------------

/** The four colours the candidate expressions index into. Order is the array order. */
const FLAG_COLOURS = ['#ff0000', '#00ff00', '#0000ff', '#ffffff'];
export const FLAG_COLOUR_NAMES = ['RED', 'GREEN', 'BLUE', 'WHITE'];

/**
 * ONE GEOMETRY PER CANDIDATE, rather than one shared geometry with `part_visibility`.
 *
 * The first version of this rig shared a geometry and had each controller hide every bone but its
 * own. In play the whole attachable was invisible — not the wrong colour, NOTHING, including the
 * stub cube that exists so "nothing drew" and "no attachable at all" look different. A
 * `part_visibility` list starting `{"*": false}` that never gets overridden produces exactly that,
 * and so does a `textures` map with no `default` entry, and guessing which cost a session.
 *
 * So both risks are gone rather than narrowed: no `part_visibility` anywhere, and each controller
 * selects its own geometry. Geometry 0 carries the stub, so a lone cube at the hand means
 * "controllers run, queries do not" — which is a different finding from "nothing rendered".
 */
function flagGeometries(count: number): unknown {
  const models: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const bones: unknown[] = [
      {
        name: `flag${i}`,
        pivot: [0, 0, 0],
        cubes: [
          {
            // Wide, tall, and pushed UP AND OUT so the player's own body cannot hide half of it.
            //
            // NOTHING HERE IS OFFSET BY ZERO. An attachable's anchor is on the BODY, so a neat
            // row of small flags near the pivot renders at roughly hip height on the third-person
            // model and two of the four sit inside the torso. The rig worked perfectly and could
            // not be read — the same failure the minimal probe had, for the same reason.
            //
            // Offset on two axes at once rather than one, deliberately: which way an attachable's
            // model space points relative to the player is part of what is being measured here,
            // so a fix that assumes which axis is "forward" could bury the rig again.
            origin: [-10 + i * 6, 14, 10],
            size: [5, 10, 1],
            uv: [0, 0],
          },
        ],
      },
    ];
    if (i === 0) {
      // The stub, on the first geometry only. One copy, so it cannot z-fight with itself.
      bones.push({
        name: 'stub',
        parent: 'flag0',
        pivot: [0, 0, 0],
        cubes: [{ origin: [-1, 0, -1], size: [2, 2, 2], uv: [0, 0] }],
      });
    }
    models.push({
      description: {
        identifier: `geometry.${PREFIX}_flag${i}`,
        texture_width: 16,
        texture_height: 16,
        visible_bounds_width: 3,
        visible_bounds_height: 3,
        visible_bounds_offset: [0, 1, 0],
      },
      bones,
    });
  }
  return { format_version: '1.12.0', 'minecraft:geometry': models };
}

/**
 * The floor: the simplest attachable Bedrock could possibly accept.
 *
 * One geometry, one texture, one material, one render controller. No texture arrays, no Molang,
 * no `part_visibility`, nothing conditional. Its only question is whether a custom item renders a
 * 3D attachable in the hand AT ALL — and until that is YES, every result from the candidate rig
 * above is unreadable, because a dark rig cannot say whether the queries are blind or whether
 * attachables simply do not work on custom items.
 *
 * Magenta because nothing else in this pack is #ff00ff and Bedrock's own missing-texture mark is
 * a magenta-and-black checker: a flat magenta cube and a checkered one are different findings.
 */
function minimalAttachableFiles(c: PackConfig): OutFile[] {
  const texture = `textures/entity/${PREFIX}_att_min`;
  return [
    { path: `RP/${texture}.png`, data: solid(16, '#ff00ff') },
    {
      path: `RP/models/entity/${PREFIX}_att_min.geo.json`,
      data: j({
        format_version: '1.12.0',
        'minecraft:geometry': [
          {
            description: {
              identifier: `geometry.${PREFIX}_att_min`,
              texture_width: 16,
              texture_height: 16,
              visible_bounds_width: 3,
              visible_bounds_height: 3,
              visible_bounds_offset: [0, 1, 0],
            },
            // Fat enough to be unmissable, and RAISED OFF THE PIVOT so it can be looked at. The
            // first version sat on the pivot itself, reasoning that a probe failing because the
            // shape was too small answers the wrong question. That was right and it overshot: in
            // first person the hand pivot is essentially at the camera, and the cube swallowed
            // the whole screen. It rendered perfectly and was unreadable, which is its own kind
            // of wrong answer.
            bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-2, 4, -2], size: [4, 4, 4], uv: [0, 0] }] }],
          },
        ],
      }),
    },
    {
      path: `RP/render_controllers/${PREFIX}_att_min.render_controllers.json`,
      data: j({
        format_version: '1.10.0',
        render_controllers: {
          [`controller.render.${PREFIX}_att_min`]: {
            geometry: 'Geometry.default',
            materials: [{ '*': 'Material.default' }],
            textures: ['Texture.default'],
          },
        },
      }),
    },
    {
      path: `RP/attachables/${PREFIX}_att_min.json`,
      data: j({
        format_version: '1.10.0',
        'minecraft:attachable': {
          description: {
            identifier: `${c.namespace}:${PREFIX}_att_min`,
            materials: { default: 'entity_alphatest' },
            textures: { default: texture },
            geometry: { default: `geometry.${PREFIX}_att_min` },
            render_controllers: [`controller.render.${PREFIX}_att_min`],
          },
        },
      }),
    },
  ];
}

/**
 * The pose rig: the same cube, declared with the vanilla hold animations.
 *
 * Separate from the minimal probe rather than a flag on it, because "it renders" and "it renders
 * IN THE HAND" are different answers and one rig cannot report both. The minimal probe deliberately
 * declares no `animations` and no `scripts.animate`, which is what makes it the control for this
 * one: whatever moves between them is the animation binding and nothing else.
 */
function posedAttachableFiles(c: PackConfig): OutFile[] {
  const texture = `textures/entity/${PREFIX}_att_pose`;
  return [
    { path: `RP/${texture}.png`, data: solid(16, '#00ffff') },
    {
      path: `RP/attachables/${PREFIX}_att_pose.json`,
      data: j({
        format_version: '1.10.0',
        'minecraft:attachable': {
          description: {
            identifier: `${c.namespace}:${PREFIX}_att_pose`,
            materials: { default: 'entity_alphatest' },
            textures: { default: texture },
            geometry: { default: `geometry.${PREFIX}_att_min` },
            render_controllers: [`controller.render.${PREFIX}_att_min`],
            // The only difference from the minimal rig. Vanilla's own names, because a custom
            // animation would answer whether OUR animation works, which nobody asked.
            animations: {
              hold_first_person: 'animation.humanoid.hold_first_person',
              hold_third_person: 'animation.humanoid.hold_third_person',
            },
            scripts: {
              animate: [
                { hold_first_person: 'c.is_first_person' },
                { hold_third_person: '!c.is_first_person' },
              ],
            },
          },
        },
      }),
    },
  ];
}

function attachableFiles(c: PackConfig): OutFile[] {
  const p = c.probes.attachable;
  const out: OutFile[] = [];

  for (let i = 0; i < FLAG_COLOURS.length; i++) {
    out.push({ path: `RP/textures/entity/${PREFIX}_flag_${i}.png`, data: solid(16, FLAG_COLOURS[i]!) });
  }

  const textures: Record<string, string> = {};
  for (let i = 0; i < FLAG_COLOURS.length; i++) {
    textures[`c${i}`] = `textures/entity/${PREFIX}_flag_${i}`;
  }

  const controllers: Record<string, unknown> = {};
  const controllerRefs: string[] = [];
  p.candidates.forEach((candidate, i) => {
    const name = `controller.render.${PREFIX}_${candidate.id}`;
    controllers[name] = {
      geometry: `Geometry.flag${i}`,
      materials: [{ '*': 'Material.default' }],
      // PARENTHESISED ON PURPOSE. Molang operator precedence eats array subscripts, and an
      // unparenthesised `mod` inside one is exactly that shape.
      textures: [`Array.palette[(${candidate.molang})]`],
      arrays: { textures: { 'Array.palette': FLAG_COLOURS.map((_, k) => `Texture.c${k}`) } },
    };
    controllerRefs.push(name);
  });

  out.push({
    path: `RP/render_controllers/${PREFIX}_attach.render_controllers.json`,
    data: j({ format_version: '1.10.0', render_controllers: controllers }),
  });

  const geometry: Record<string, string> = {};
  p.candidates.forEach((_, i) => {
    geometry[`flag${i}`] = `geometry.${PREFIX}_flag${i}`;
  });

  // BOTH ITEMS SHARE ONE ATTACHABLE. They differ only in damage, which is the whole design: two
  // attachables would make "the two items drew differently" ambiguous between the damage and the
  // rig, and that ambiguity is the one this probe exists to remove.
  for (const id of probeIds(c).attach) {
    out.push({
      path: `RP/attachables/${id.split(':')[1]}.json`,
      data: j({
        format_version: '1.10.0',
        'minecraft:attachable': {
          description: {
            identifier: id,
            materials: { default: 'entity_alphatest', enchanted: 'entity_alphatest_glint' },
            textures: {
              // `default` is not optional even though no controller names it. An attachable whose
              // texture map lacks it is one of the two shapes that rendered NOTHING in play, and
              // it costs one line to remove from the suspects forever.
              default: `textures/entity/${PREFIX}_flag_0`,
              ...textures,
              enchanted: 'textures/misc/enchanted_item_glint',
            },
            geometry: { default: `geometry.${PREFIX}_flag0`, ...geometry },
            render_controllers: controllerRefs,
          },
        },
      }),
    });
  }

  out.push({
    path: `RP/models/entity/${PREFIX}_flags.geo.json`,
    data: j(flagGeometries(p.candidates.length)),
  });

  out.push(...minimalAttachableFiles(c));
  out.push(...posedAttachableFiles(c));

  return out;
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
  /** Only the external-writes probe wants this. Everything else must stay un-enchantable. */
  enchantable?: { slot: string; value: number };
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
  if (spec.enchantable) {
    components['minecraft:enchantable'] = { slot: spec.enchantable.slot, value: spec.enchantable.value };
  }

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

  // The one item in the pack that is deliberately ENCHANTABLE, because the question it serves
  // is whether Mending can reach a custom item's damage. It still omits `minecraft:repairable`
  // -- that omission is the mitigation being tested, so declaring it would answer the question
  // by construction.
  specs.push({
    id: ids.repair,
    texture: `${PREFIX}_dur`,
    name: 'external writes: can anything reach this damage?',
    category: 'items',
    maxDurability: 250,
    enchantable: { slot: 'pickaxe', value: 15 },
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

  // P3/P4 — the attachable. TWO ITEMS DIFFERING ONLY IN DAMAGE, and the damages are in the name
  // so a screenshot of two flags in a row says which is which without anyone remembering.
  ids.attach.forEach((id, i) => {
    const damage = i === 0 ? p.attachable.damage : p.attachable.damage_b;
    specs.push({
      id,
      texture: `${PREFIX}_dur`,
      name: `P3b attachable · damage ${damage}`,
      category: 'items',
      maxDurability: p.attachable.max_durability,
    });
  });

  specs.push({ id: ids.attach_min, texture: `${PREFIX}_dur`, name: 'P3a minimal attachable', category: 'items' });
  specs.push({ id: ids.attach_pose, texture: `${PREFIX}_dur`, name: 'P3c hold-pose attachable', category: 'items' });

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
    '  repair: string;',
    '  flipbook: string[];',
    '  menu: MenuId[];',
    '  containers: ContainerId[];',
    '  attach: string[];',
    '  attach_min: string;',
    '  attach_pose: string;',
    '  stash_carrier: string;',
    '  stash_holder: string;',
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
    ...attachableFiles(c),
    ...textureFiles(c),
    ...languageFiles(c),
  ];
}

// ---------------------------------------------------------------------------
// The questions, embedded in the pack
// ---------------------------------------------------------------------------

/**
 * The ordered list of eyes-only capabilities the guided session asks.
 *
 * ORDERED BY ID, and the order is load-bearing rather than tidy. The answer code carries an
 * INDEX into this list, not a capability id — ids are far too long to type off a screenshot —
 * so the pack and the redeemer have to derive the same order from the same catalog. Sorting by
 * id does that with no shared state beyond the catalog itself, and the catalog revision travels
 * in the code so a mismatch is refused rather than misread.
 */
export function sessionQuestions(catalog: Catalog): Capability[] {
  return catalog.capabilities
    .filter((c) => c.method === 'observed')
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * `pack/scripts/catalog.generated.ts` — everything the session needs to run without a network.
 *
 * The pack carries its own questions because it has to: a client cannot fetch anything, so an
 * add-on that did not already know what to ask could not ask it. That is also why this is
 * published per Minecraft version alongside the manifest — the pack and the answers it produces
 * are two halves of one artifact.
 *
 * `askByDefault` is a SNAPSHOT taken when the pack was built, not an authority. It lets a
 * session default to "the rows that needed eyes when this was published" instead of asking all
 * thirty every time. Which rows genuinely need answering is settled when the code is redeemed,
 * against a ledger that may have moved since.
 */
/**
 * The search each `solved` row declares, handed to the runtime as data.
 *
 * A solve has two halves that live in two files for a reason. The RANGE, the DIRECTION, the UNIT
 * and the TOLERANCE belong to the question — they say what is being measured and how finely the
 * answer means anything — so they live in the catalog beside the question. Repeats, timings and
 * block choices belong to the instrument and live in `content/pack.yaml`.
 *
 * Copying either into the other would let a probe search a range the catalog does not describe,
 * and the ledger would record the number under a row that asked something else. So the runtime
 * reads the question's half from here rather than restating it.
 */
export function solveSpecs(catalog: Catalog): Capability[] {
  return catalog.capabilities
    .filter((c) => c.method === 'solved' && c.measures?.search)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function sessionModule(catalog: Catalog, observations: Observation[], version: string): string {
  const questions = sessionQuestions(catalog);
  const solves = solveSpecs(catalog).map((cap) => ({
    id: cap.id,
    probe: cap.probe ?? '',
    unit: cap.measures!.unit,
    direction: cap.measures!.direction,
    from: cap.measures!.search!.from,
    to: cap.measures!.search!.to,
    tolerance: cap.measures!.tolerance,
  }));
  const rows = questions.map((cap, index) => {
    const status = resolveWithDeps(cap, version, observations, catalog).status;
    return {
      index,
      id: cap.id,
      probe: cap.probe ?? '',
      question: cap.question.replace(/\s+/g, ' ').trim(),
      look_at: (cap.look_at ?? '').replace(/\s+/g, ' ').trim(),
      // Anything that is not already a confirmed yes. A measured NO is included deliberately:
      // it is the row most worth re-asking on a Bedrock nobody has looked at yet.
      askByDefault: status !== 'SETTLED',
      priorStatus: status,
      outcomes: (cap.outcomes ?? []).map((o) => ({
        id: o.id,
        label: o.label.replace(/\s+/g, ' ').trim(),
        verdict: o.verdict,
        means: (o.means ?? '').replace(/\s+/g, ' ').trim(),
      })),
    };
  });

  return [
    '// GENERATED by tools/gen/pack.ts — do not edit.',
    '// The questions this pack can ask, and the answer space for each.',
    '',
    'export interface SessionOutcome { id: string; label: string; verdict: string; means: string }',
    'export interface SessionQuestion {',
    '  index: number;',
    '  id: string;',
    '  probe: string;',
    '  question: string;',
    '  look_at: string;',
    '  askByDefault: boolean;',
    '  priorStatus: string;',
    '  outcomes: SessionOutcome[];',
    '}',
    '',
    'export interface SolveSpec {',
    '  id: string;',
    '  probe: string;',
    '  unit: string;',
    "  direction: 'minimum' | 'maximum';",
    '  from: number;',
    '  to: number;',
    '  tolerance: number;',
    '}',
    '',
    `export const CATALOG_REVISION = ${JSON.stringify(catalogRevision())};`,
    `export const SNAPSHOT_VERSION = ${JSON.stringify(version)};`,
    `export const QUESTIONS: SessionQuestion[] = ${JSON.stringify(rows, null, 2)};`,
    `export const SOLVES: SolveSpec[] = ${JSON.stringify(solves, null, 2)};`,
    '',
  ].join('\n');
}
