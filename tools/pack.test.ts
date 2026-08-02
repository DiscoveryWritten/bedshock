/**
 * The apparatus's own correctness.
 *
 * A probe is an instrument, and an instrument that is subtly wrong is worse than no
 * instrument: it produces an answer, the answer goes into the ledger, and every later decision
 * rests on it. Nothing in-game can tell you a probe was misconfigured — the screenshot looks
 * just as convincing either way.
 *
 * So these pin the properties that make each probe READABLE, which is a different thing from
 * whether the JSON is valid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

import { loadCatalog } from './catalog.ts';
import { loadPackConfig, validatePackConfig, type PackConfig } from './config.ts';
import { minimumRowSeparation, RULER_ROWS, glyphPage, rulerSprite, flipbookStrip } from './gen/assets.ts';
import { generatedModule, packFiles, probeIds } from './gen/pack.ts';

const config = loadPackConfig();
const files = packFiles(config);
const paths = files.map((f) => f.path);
const json = (path: string): any => {
  const file = files.find((f) => f.path === path);
  assert.ok(file, `nothing emitted at ${path}`);
  return JSON.parse(String(file.data));
};

// ---------------------------------------------------------------------------
// The config's own rules
// ---------------------------------------------------------------------------

test('the shipped pack config is valid', () => {
  assert.deepEqual(validatePackConfig(config), []);
});

/**
 * The boundary IS the measurement. A ceiling list that stops below 32767 cannot tell a wrap
 * from a clamp, and a clamp has a safe failure mode where a wrap does not.
 */
test('the durability ceilings bracket the int16 boundary', () => {
  assert.ok(config.probes.durability.ceilings.some((n) => n <= 32767));
  assert.ok(config.probes.durability.ceilings.some((n) => n > 32767));
  const trimmed: PackConfig = {
    ...config,
    probes: { ...config.probes, durability: { ceilings: [2031, 4096] } },
  };
  assert.match(validatePackConfig(trimmed).join('\n'), /no value above 32767/);
});

/**
 * Single variable or nothing. If the chest and horse variants differ in anything but
 * `container_type`, a behavioural difference between them cannot be attributed.
 */
test('the container variants form a single-variable comparison', () => {
  const chest = config.probes.containers.filter((c) => c.container_type === 'chest');
  const horse = config.probes.containers.filter((c) => c.container_type === 'horse');
  assert.ok(chest.length && horse.length);
  assert.ok(chest.some((c) => horse.some((h) => h.size === c.size)), 'the two families must share a size');

  const mismatched: PackConfig = {
    ...config,
    probes: {
      ...config.probes,
      containers: [
        { id: 'chest5', container_type: 'chest', size: 5 },
        { id: 'horse9', container_type: 'horse', size: 9 },
      ],
    },
  };
  assert.match(validatePackConfig(mismatched).join('\n'), /share no size/);
});

/** The client's ejection is not instant. Reading too early reports a false persistence. */
test('the off-hand settle delay is at least a second', () => {
  assert.ok(config.probes.offhand.settle_ticks >= 20);
  const hasty: PackConfig = {
    ...config,
    probes: { ...config.probes, offhand: { ...config.probes.offhand, settle_ticks: 5 } },
  };
  assert.match(validatePackConfig(hasty).join('\n'), /under a second/);
});

// ---------------------------------------------------------------------------
// Readability
// ---------------------------------------------------------------------------

/**
 * A probe you cannot read is not a cheaper probe. An earlier version of this palette used two
 * blues 83 apart in RGB, which are indistinguishable at hotbar scale — which is where the
 * measurement is actually taken.
 */
test('the ruler rows are separable where the measurement is actually taken', () => {
  assert.equal(RULER_ROWS.length, 16);

  // Rows 11-15 are where the bar lands, and they are read off a downscaled hotbar tile. These
  // have to be unmistakable: pure primaries and secondaries rather than a pleasant ramp.
  const bottom = minimumRowSeparation(RULER_ROWS.slice(11));
  assert.ok(bottom >= 150, `two rows in the bar's own range are only ${Math.round(bottom)} apart in RGB`);

  // Everywhere else a looser floor is fine, because the notches at rows 0/4/8/12 are what
  // rows are counted by. Still a floor rather than nothing: a palette with two identical rows
  // would make a count ambiguous even with notches to anchor it.
  const overall = minimumRowSeparation();
  assert.ok(overall >= 40, `two ruler rows are only ${Math.round(overall)} apart in RGB`);
});

test('the ruler sprite is 16x16 and paints one row per colour, with counting notches', () => {
  const png = PNG.sync.read(rulerSprite());
  assert.equal(png.width, 16);
  assert.equal(png.height, 16);
  const at = (x: number, y: number) => {
    const i = (y * 16 + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]].join(',');
  };
  // Row 15 is the bottom row and is pure red; row 0 is the top and is near-black.
  assert.equal(at(8, 15), '255,0,0');
  assert.equal(at(8, 0), '32,32,32');
  // Notches at 0, 4, 8, 12 so rows are counted rather than estimated.
  for (const row of [0, 4, 8, 12]) assert.equal(at(0, row), '0,0,0', `no notch on row ${row}`);
  assert.notEqual(at(0, 1), '0,0,0');
});

/** A shape with a hole, so partial-alpha handling shows up as well as colour. */
test('the glyph page draws rings on transparency, one per swatch', () => {
  const png = PNG.sync.read(glyphPage(config.probes.glyphs.swatches));
  assert.equal(png.width, 256);
  assert.equal(png.height, 256);
  const alpha = (x: number, y: number) => png.data[(y * 256 + x) * 4 + 3];
  assert.equal(alpha(8, 8), 0, 'the first ring has no hole — transparency would be untestable');
  assert.ok(alpha(8, 1)! > 0, 'the first ring has no rim');
  assert.equal(alpha(200, 200), 0, 'unused cells must stay empty');
});

test('flipbook frames are all different, or "does it cycle" is unanswerable', () => {
  const png = PNG.sync.read(flipbookStrip(4));
  assert.equal(png.height, 64);
  const frame = (i: number) => {
    const p = (i * 16 * 16 + 8 * 16 + 8) * 4;
    return [png.data[p], png.data[p + 1], png.data[p + 2]].join(',');
  };
  const colours = [0, 1, 2, 3].map(frame);
  assert.equal(new Set(colours).size, 4);
});

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

test('one item is emitted per declared durability ceiling', () => {
  for (const entry of probeIds(config).durability) {
    const item = json(`BP/items/${entry.id.split(':')[1]}.json`);
    assert.equal(item['minecraft:item'].components['minecraft:durability'].max_durability, entry.declared);
  }
});

/**
 * `minecraft:repairable` anywhere in this pack would let an anvil, a grindstone or Mending
 * rewrite a value a probe is trying to read back — a probe measuring its own contamination.
 */
test('nothing in the pack declares itself repairable', () => {
  for (const file of files.filter((f) => f.path.startsWith('BP/items/'))) {
    assert.ok(!String(file.data).includes('minecraft:repairable'), `${file.path} is repairable`);
  }
});

/**
 * The form-icon probe asks whether a texture NOT in the atlas resolves. Its absence there is
 * the entire experiment; adding it would answer a different question and look identical.
 */
test('the unindexed form icon exists as a file and is absent from the atlas', () => {
  assert.ok(paths.includes('RP/textures/probe/icon_unindexed.png'));
  const atlas = json('RP/textures/item_texture.json');
  const referenced = JSON.stringify(atlas.texture_data);
  assert.ok(!referenced.includes('probe/icon_unindexed'), 'the unindexed icon is in the atlas — the probe now measures nothing');
});

test('the two flipbook entries are spelled differently in every field that could be the mistake', () => {
  const [a, b] = json('RP/textures/flipbook_textures.json');
  assert.ok('frames' in a && !('frames' in b), 'both entries declare frames the same way');
  assert.notEqual(a.blend_frames, b.blend_frames);
  assert.notEqual(a.atlas_tile, b.atlas_tile);
});

test('the container entities differ only in container_type', () => {
  const of = (id: string) => json(`BP/entities/${id.split(':')[1]}.json`)['minecraft:entity'].components;
  const ids = probeIds(config).containers;
  const chest = ids.find((c) => c.container_type === 'chest')!;
  const horse = ids.find((c) => c.container_type === 'horse' && c.size === chest.size)!;

  const a = of(chest.id);
  const b = of(horse.id);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  for (const key of Object.keys(a)) {
    if (key === 'minecraft:inventory') continue;
    assert.deepEqual(a[key], b[key], `${key} differs between the two container variants`);
  }
  assert.equal(a['minecraft:inventory'].inventory_size, b['minecraft:inventory'].inventory_size);
  assert.notEqual(a['minecraft:inventory'].container_type, b['minecraft:inventory'].container_type);
  // Carried on both, so its lack of effect on the chest variant is measurable rather than assumed.
  assert.ok('minecraft:is_chested' in a && 'minecraft:is_chested' in b);
  // A private inventory cannot be opened at all, which would answer the question by construction.
  assert.equal(a['minecraft:inventory'].private, false);
});

test('the creative-menu variants cover omission, none, plain and grouped', () => {
  const variants = probeIds(config).menu;
  const omitted = variants.find((v) => v.id.endsWith('_omitted'))!;
  const item = json(`BP/items/${omitted.id.split(':')[1]}.json`);
  assert.ok(!('menu_category' in item['minecraft:item'].description), 'the omitted variant declares a menu_category');

  const none = variants.find((v) => v.id.endsWith('_none'))!;
  assert.equal(json(`BP/items/${none.id.split(':')[1]}.json`)['minecraft:item'].description.menu_category.category, 'none');

  const grouped = variants.filter((v) => v.group);
  assert.ok(grouped.length >= 2, 'nesting cannot be read from fewer than two grouped items');
  assert.equal(new Set(grouped.map((v) => v.group)).size, 1, 'grouped variants must share one group string');
});

test('every emitted item is named in the language file, so a picker screenshot is self-describing', () => {
  const lang = String(files.find((f) => f.path === 'RP/texts/en_US.lang')!.data);
  for (const file of files.filter((f) => f.path.startsWith('BP/items/'))) {
    const id = JSON.parse(String(file.data))['minecraft:item'].description.identifier;
    assert.match(lang, new RegExp(`^item\\.${id.replace('.', '\\.')}=`, 'm'), `${id} has no display name`);
  }
});

test('the manifest declares the resource pack as a dependency, and vice versa', () => {
  const bp = json('BP/manifest.json');
  const rp = json('RP/manifest.json');
  assert.ok(bp.dependencies.some((d: any) => d.uuid === config.uuids.rp_header));
  assert.ok(rp.dependencies.some((d: any) => d.uuid === config.uuids.bp_header));
  // A pack declaring a script module the game does not have is rejected ENTIRELY and silently,
  // which is the single most likely way for a battery run to measure nothing.
  for (const [name, version] of Object.entries(config.script.modules)) {
    assert.ok(bp.dependencies.some((d: any) => d.module_name === name && d.version === version), `${name} unpinned`);
  }
});

test('the generated module names every id the emitted pack contains', () => {
  const module = generatedModule(config);
  for (const entry of probeIds(config).durability) assert.ok(module.includes(entry.id));
  for (const variant of probeIds(config).containers) assert.ok(module.includes(variant.id));
});

// ---------------------------------------------------------------------------
// Catalog <-> apparatus
// ---------------------------------------------------------------------------

/**
 * A capability naming a probe that does not exist sits in the matrix looking like a question
 * somebody could go and answer. The build warns about this; this test pins the ones we KNOW
 * are outstanding, so the list shrinking is visible and the list growing is deliberate.
 */
test('the probes not yet ported are exactly the ones we know about', () => {
  const catalog = loadCatalog();
  const implemented = new Set([
    'durability', 'dynprops', 'container', 'offhand', 'menu', 'fallingblock',
    'repair', 'ruler', 'glyphs', 'flipbook', 'formicon',
  ]);
  const missing = [...new Set(
    catalog.capabilities.filter((c) => c.probe && !implemented.has(c.probe)).map((c) => c.probe!),
  )].sort();
  assert.deepEqual(missing, ['attachable', 'attachable_pose', 'stash']);
});

/**
 * The external-writes probe is the only enchantable item here, and that is load-bearing in two
 * directions. It must be enchantable, or Mending cannot be applied to ask the question. And it
 * must still omit `minecraft:repairable`, because that omission IS the mitigation being tested
 * — declaring it would answer the question by construction.
 */
test('exactly one item is enchantable, and it is still not repairable', () => {
  const enchantable = files
    .filter((f) => f.path.startsWith('BP/items/'))
    .filter((f) => String(f.data).includes('minecraft:enchantable'));
  assert.equal(enchantable.length, 1);
  assert.match(enchantable[0]!.path, /probe_repair/);
  assert.ok(!String(enchantable[0]!.data).includes('minecraft:repairable'));
  assert.ok(String(enchantable[0]!.data).includes('minecraft:durability'));
});
