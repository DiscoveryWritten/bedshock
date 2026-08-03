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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { CHAPTERS } from '../pack/scripts/chapters.ts';
import { crossCheck, implementedProbes } from './build.ts';
import { loadCatalog } from './catalog.ts';
import { loadPackConfig, validatePackConfig, type PackConfig } from './config.ts';
import { minimumRowSeparation, RULER_ROWS, glyphPage, rulerSprite, flipbookStrip } from './gen/assets.ts';
import { generatedModule, packFiles, probeIds } from './gen/pack.ts';
import { BUILD_DIR, ROOT } from './paths.ts';

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

/**
 * EVERY PROBE BELONGS TO A CHAPTER, or it never runs in a guided session.
 *
 * The chapters are how a person walks the battery: each builds its facility from nothing, runs
 * what needs it, and stops so the thing can be looked at. A probe left out of every chapter still
 * exists, still works headless, and is silently unreachable to somebody with a tablet — which is
 * the only way half these rows can ever be answered.
 *
 * The registry lives in `main.ts` and the chapters in `chapters.ts`, and neither imports the
 * other's list. Nothing but a cross-check notices when they drift.
 */
test('every probe is in exactly one chapter', () => {
  const main = readFileSync(join(ROOT, 'pack', 'scripts', 'main.ts'), 'utf8');
  const registry = main.slice(main.indexOf('const PROBES'), main.indexOf('/** Follow-ups'));
  const declared = [...registry.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!);
  assert.ok(declared.length >= 10, `only found ${declared.length} probes in the registry`);

  const chaptered = CHAPTERS.flatMap((c) => c.probes);
  for (const probe of declared) {
    assert.ok(chaptered.includes(probe), `probe "${probe}" is in no chapter — unreachable in a session`);
  }
  for (const probe of chaptered) {
    assert.ok(declared.includes(probe), `chapter names "${probe}", which is not in the registry`);
  }
});

/**
 * THE CONTAINER SIZES EXIST TO TELL RULES APART, not to sample evenly.
 *
 * An informal session reported `horse1` drawing nothing and `horse5` drawing "about three (?)".
 * At least two rules fit both of those — `declared - 2` and `declared floored to a multiple of
 * 3` — and they agree at 1 and 5, which is exactly the pair that happened to get tried. They
 * disagree at 3, 4 and 6.
 *
 * So a variant list without one of those sizes cannot separate the candidates however many
 * containers a person empties by hand, and the whole discovery pass becomes busywork that
 * confirms what was already ambiguous.
 */
test('the container sizes include one where the candidate slot-count rules disagree', () => {
  const horses = config.probes.containers.filter((v) => v.container_type === 'horse').map((v) => v.size);
  assert.ok(horses.some((n) => [3, 4, 6].includes(n)), `horse sizes ${horses.join(', ')} cannot separate the rules`);

  // And the two rules really do agree on the sizes that were tried informally, which is why
  // this test exists rather than a comment.
  const minusTwo = (d: number) => Math.max(0, d - 2);
  const flooredToThree = (d: number) => Math.floor(d / 3) * 3;
  for (const agreed of [1, 5]) assert.equal(minusTwo(agreed), flooredToThree(agreed));
  for (const differs of [3, 4, 6]) assert.notEqual(minusTwo(differs), flooredToThree(differs));

  const blind: PackConfig = {
    ...config,
    probes: {
      ...config.probes,
      containers: [
        { id: 'chest5', container_type: 'chest', size: 5 },
        { id: 'horse5', container_type: 'horse', size: 5 },
        { id: 'horse1', container_type: 'horse', size: 1 },
      ],
    },
  };
  assert.match(validatePackConfig(blind).join('\n'), /candidate slot-count rules disagree/);
});

/**
 * The discovery pass has two halves and the second one has to be reachable.
 *
 * Filling every slot with a marker is useless if nothing reads them back, and the read-back is a
 * separate scriptevent because a person has to empty the containers in between. A registry that
 * lost the follow-up would leave the probe setting up an experiment nobody can conclude.
 */
test('the container discovery pass can actually be read back', () => {
  const main = readFileSync(join(ROOT, 'pack', 'scripts', 'main.ts'), 'utf8');
  assert.match(main, /'container\.read'/, 'the read-back follow-up is not registered');
  const source = readFileSync(join(ROOT, 'pack', 'scripts', 'probes', 'container.ts'), 'utf8');
  assert.match(source, /export function read/);
  // The person is the hands, not the instrument: the verdict must come from container state,
  // never from a `look` asking them for a number.
  assert.match(source, /reachable_slots_match_declared_size/);
  const readBody = source.slice(source.indexOf('export function read'));
  assert.ok(!/\blook\(/.test(readBody), 'the discovery read-back asks a person to report something');
});

/**
 * THE OFF-HAND FILE NEEDS A CONTROL, and it is the row that is supposed to PASS.
 *
 * Every other row here is expected to be NO — that is the whole finding, and it is what a mod
 * author is meant to design around. Which makes this file uniquely dangerous: a probe that had
 * silently stopped writing anything at all would produce exactly the same confident row of NOs
 * as one working perfectly, and nothing about reading the results would show the difference.
 *
 * The control is an item the off-hand is SUPPOSED to keep. It has to be answered by the same
 * probe — a control living somewhere else controls nothing — and it must not be one of the items
 * the negatives are measured with, or it is not a comparison.
 */
test('the off-hand negatives are backed by a control that is supposed to pass', () => {
  const catalog = loadCatalog();
  const control = catalog.byId.get('equipment.offhand.vanilla_permitted_item_persists');
  assert.ok(control, 'the off-hand file has no control');
  const persists = catalog.byId.get('equipment.offhand.script_placed_item_persists')!;
  assert.equal(control!.probe, persists.probe, 'the control is answered by a different probe');

  const o = config.probes.offhand;
  assert.ok(o.permitted_item, 'no control item is declared');
  assert.ok(!o.arbitrary_items.includes(o.permitted_item), 'the control item is also on trial');

  const noControl: PackConfig = {
    ...config,
    probes: { ...config.probes, offhand: { ...o, permitted_item: '' } },
  };
  assert.match(validatePackConfig(noControl).join('\n'), /control for this whole file/);
});

/**
 * And the negative is measured across a SPREAD. "Arbitrary items are ejected" and "a diamond is
 * ejected" are different claims; a manifest is only worth contorting around if it makes the
 * first one.
 */
test('the off-hand negative is measured across several kinds of item, not one', () => {
  const items = config.probes.offhand.arbitrary_items;
  assert.ok(items.length >= 3, `only ${items.length} item(s) on trial`);
  assert.equal(new Set(items).size, items.length, 'a duplicate answers the same question twice');

  const single: PackConfig = {
    ...config,
    probes: { ...config.probes, offhand: { ...config.probes.offhand, arbitrary_items: ['minecraft:diamond'] } },
  };
  assert.match(validatePackConfig(single).join('\n'), /about one item/);
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
    'fallcurve', 'anvilgap', 'throw', 'knockback', 'repair', 'distribution', 'ruler', 'glyphs',
    'flipbook', 'formicon',
  ]);
  const missing = [...new Set(
    catalog.capabilities.filter((c) => c.probe && !implemented.has(c.probe)).map((c) => c.probe!),
  )].sort();
  // What is left is eyes-only apparatus, not measurement: `attachable` and `stash` need a client
  // to look at. Listed rather than quietly omitted, because the build prints this same set on
  // every run and a shrinking list is the only progress bar there is.
  assert.deepEqual(missing, ['attachable', 'attachable_pose', 'stash']);
});

/**
 * Both shapes of solved row have a runtime, and the runtime matches the shape.
 *
 * A measured row put through `solve` would bisect a boundary that does not exist and burn dozens
 * of trials arriving at INCONCLUSIVE; a boundary row put through `measure` would ask an apparatus
 * for a number it cannot produce. Neither mistake shows up in a type — both files compile, both
 * probes run, and the failure appears only as a strange result on a real server.
 */
test('every solved row uses the tool that matches its shape', () => {
  const dir = join(ROOT, 'pack', 'scripts', 'probes');
  const sources = new Map<string, string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    sources.set(name.replace(/\.ts$/, ''), readFileSync(join(dir, name), 'utf8'));
  }

  // Read from the IMPORTS rather than from call sites, because prose mentions both tools by
  // name and a scan of the whole file matches the paragraph explaining the choice.
  const imports = (probe: string): string[] =>
    [...sources.get(probe)!.matchAll(/from '\.\.\/(\w+)\.ts'/g)].map((m) => m[1]!);

  // A boundary: the apparatus can only say whether something worked, so it is bisected.
  assert.ok(imports('anvilgap').includes('solve'), 'anvilgap should search for a boundary');
  assert.ok(!imports('anvilgap').includes('measure'), 'anvilgap measures a number it cannot produce');

  // Measurements: the apparatus hands back a distance, so the readings are summarised.
  for (const probe of ['throw', 'knockback']) {
    assert.ok(imports(probe).includes('measure'), `${probe} should measure, not search`);
    assert.ok(!imports(probe).includes('solve'), `${probe} bisects a boundary that does not exist`);
  }
});

/**
 * EVERY MOVING PROBE NEEDS ITS OWN GROUND, and nothing about reading the code shows when it does
 * not.
 *
 * Probes run concurrently — each one starts a tick loop and returns — so two measuring in
 * overlapping space clear each other's blocks and delete each other's entities. The result does
 * not look like interference. It looks like physics: the throw probe lost three readings in five
 * to exactly this, reporting `the item stopped existing after 7 tick(s), 3.425 blocks along`,
 * which reads like a despawn and was a neighbour's broom.
 */
test('the moving probes are on lanes far enough apart not to sweep each other', () => {
  const lanes = {
    fallcurve: config.probes.falling_block.lane,
    anvilgap: config.probes.anvilgap.lane,
    throw: config.probes.throw.lane,
    knockback: config.probes.knockback.lane,
  };
  assert.equal(new Set(Object.values(lanes)).size, 4, `two probes share a lane: ${JSON.stringify(lanes)}`);

  const sorted = Object.values(lanes).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i]! - sorted[i - 1]! >= 4, `lanes ${sorted[i - 1]} and ${sorted[i]} are too close`);
  }

  const clashing: PackConfig = {
    ...config,
    probes: { ...config.probes, throw: { ...config.probes.throw, lane: config.probes.anvilgap.lane + 1 } },
  };
  assert.match(validatePackConfig(clashing).join('\n'), /sweep each other/);
});

/**
 * And every probe that moves something has to read its lane, or declaring one changes nothing.
 */
test('each moving probe actually offsets itself by its lane', () => {
  const dir = join(ROOT, 'pack', 'scripts', 'probes');
  for (const [file, param] of [
    ['fallcurve.ts', 'falling_block'],
    ['anvilgap.ts', 'anvilgap'],
    ['throw.ts', 'throw'],
    ['knockback.ts', 'knockback'],
  ]) {
    const source = readFileSync(join(dir, file!), 'utf8');
    assert.match(source, new RegExp(`PARAMS\\.${param}\\.lane`), `${file} declares a lane it never uses`);
  }
});

/**
 * A measurement taken in a place nobody checked is a measurement of the terrain.
 *
 * An item that stops after two blocks stopped because it hit a wall; an entity that does not move
 * is standing in a hole. Both produce a number and both look like physics. The arena's `verify()`
 * is the only thing that tells those apart, so a probe that carves without verifying has quietly
 * given up the distinction.
 */
test('every probe that carves an arena also verifies it before measuring', () => {
  const dir = join(ROOT, 'pack', 'scripts', 'probes');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, name), 'utf8');
    if (!source.includes('arena(')) continue;
    assert.match(source, /\.verify\(\)/, `${name} builds an arena it never checks is there`);
    assert.match(source, /record\(null/, `${name} has no path for reporting the arena missing`);
  }
});

/**
 * The check that stopped being able to fail.
 *
 * The build warns about capabilities with no runtime. Then the guided session's questions were
 * embedded in the pack — a JSON literal full of capability ids — and every row in the catalog
 * started matching the scan. The warning went quiet, no test failed, and the build looked
 * exactly as clean as it had the day before. That is the worst shape a check can take: people
 * believe it.
 *
 * So the check is now checked. Embedded data and reporting code are told apart by shape, and
 * both directions are pinned here because neither is visible by reading a build log.
 */
test('a capability carried only as embedded data is not credited with a runtime', () => {
  const catalog = loadCatalog();
  const solved = catalog.capabilities.find((c) => c.method === 'solved')!;
  const observed = catalog.capabilities.find((c) => c.method === 'observed')!;
  // A bundle containing nothing but the embedded questions, exactly as `sessionModule` writes
  // them. Every id in the catalog appears in it.
  const embedded = catalog.capabilities.map((c) => `  { "id": ${JSON.stringify(c.id)}, "probe": "x" },`).join('\n');

  const blind = crossCheck(embedded, embedded).join('\n');
  assert.match(blind, /have no runtime in this pack/, 'the embedded catalog credited itself');
  assert.ok(blind.includes(solved.id), 'a solved row with no probe code was reported as implemented');

  // An `observed` row is different: being in the embedded questions IS its runtime, because the
  // guided session is what asks it.
  assert.ok(!blind.includes(observed.id), 'an eyes-only row the session can ask was called unimplemented');

  // And code naming the capability still counts, even though the same id is in the data.
  const withCode = crossCheck(`${embedded}\nvar CAPABILITY = ${JSON.stringify(solved.id)};`, embedded);
  assert.ok(!withCode.join('\n').includes(solved.id), 'a probe that names its capability was not credited');

  // A bundle with no readable registry cannot tell an askable question from an unaskable one, and
  // has to say so rather than quietly crediting everything the way it used to.
  assert.match(blind, /probe registry could not be read/, 'an unreadable registry passed silently');
});

/**
 * The SECOND way the same check went quiet, and the one somebody else was relying on.
 *
 * Crediting an `observed` row for being in the embedded questions is only right when there is
 * something to look at. Three rigs — `attachable`, `attachable_pose`, `stash` — are named by eight
 * capabilities and built by nothing, and for as long as the credit was unconditional the build
 * reported a clean bill on every run. composable-portals' `docs/CAPABILITIES.md` was pointing at
 * that list to decide when its own copies were safe to delete.
 */
test('an eyes-only row whose rig this pack does not build is not credited with a runtime', () => {
  const catalog = loadCatalog();
  const observed = catalog.capabilities.find((c) => c.method === 'observed' && c.probe)!;
  const embedded = catalog.capabilities.map((c) => `  { "id": ${JSON.stringify(c.id)} },`).join('\n');

  const withoutRig = crossCheck(`${embedded}\nvar PROBES = {\n  somethingElse: run\n};`, embedded);
  assert.ok(
    withoutRig.join('\n').includes(observed.id),
    `"${observed.id}" was credited a runtime by a pack that builds no "${observed.probe}"`,
  );
  assert.match(withoutRig.join('\n'), /built by nothing/, 'the unbuilt rigs were not named');

  const withRig = crossCheck(`${embedded}\nvar PROBES = {\n  ${observed.probe}: run\n};`, embedded);
  assert.ok(
    !withRig.join('\n').includes(observed.id),
    'a question the session can ask, with apparatus to look at, was called unimplemented',
  );
});

/**
 * The registry is read out of compiled output, which is a thing that stops working quietly.
 *
 * A renamed binding or a different emit shape would make `implementedProbes` return nothing, and
 * an empty set reads as "this pack implements no probes" — every capability reported unimplemented,
 * which is noise people scroll past. It returns null instead, and this pins that the real bundle
 * is parsed rather than merely not crashing.
 */
test('the probe registry is readable out of the real bundle, in both property spellings', () => {
  const bundlePath = join(BUILD_DIR, 'BP', 'scripts', 'main.js');
  if (!existsSync(bundlePath)) return; // `npm run build` has not run; other tests cover the parser
  const names = implementedProbes(readFileSync(bundlePath, 'utf8'));
  assert.ok(names, 'the probe registry could not be found in the built bundle');
  // `durability: run` is the long form and `ruler,` is shorthand. Missing the shorthand reported
  // four built probes as unbuilt, which is the same wrong answer as the bug being fixed.
  assert.ok(names.has('durability'), 'a `name: value` probe was missed');
  assert.ok(names.has('ruler'), 'a shorthand probe was missed');
});

/**
 * A solve's two halves have to agree, and nothing in either file can see the other.
 *
 * The catalog owns the RANGE (it is part of what is being asked); `content/pack.yaml` owns the
 * DROP (it is the instrument). If the range does not reach past the drop, the loose bound is a
 * clearance the anvil never has — so the bound check that exists to catch a broken apparatus
 * becomes a coin flip on tick phase, and the search's first line of defence is gone with no
 * error anywhere.
 */
test('the anvil search reaches past the drop, so its tight bound fails by construction', () => {
  const cap = loadCatalog().byId.get('physics.falling_block.min_clearance_under_a_falling_anvil')!;
  const search = cap.measures!.search!;
  // MAXIMUM: leaving EARLY is what eventually fails. The first runnable apparatus searched for a
  // minimum and a real server answered `held even at 0` — removal keyed to the anvil's own
  // arrival is never late, so every clearance passed and the row could not have moved between
  // versions. If this flips back to `minimum`, that measurement is being un-learned.
  assert.equal(cap.measures!.direction, 'maximum');
  assert.ok(
    search.to > config.probes.anvilgap.drop_height,
    `the search stops at ${search.to} but the anvil only falls ${config.probes.anvilgap.drop_height} ` +
      `blocks, so no trial can ever ask for a clearance that wide`,
  );
  // And the tolerance has to stay above one tick of travel, or the bisection narrows past what
  // tick-spaced positions can distinguish and reports DRIFT on phase forever.
  assert.ok(cap.measures!.tolerance >= 0.3, 'the tolerance is finer than one tick of falling');
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

/**
 * A probe that reports on a timer must register for the wait.
 *
 * `DONE` is the marker the harness watches, and it stops the server the moment it appears. So a
 * probe still counting ticks when `DONE` printed has its result thrown away — and the row is
 * then ABSENT from the log: not a pass, not a fail, not even a skip. That is the one output
 * this battery must never produce silently, because absence is indistinguishable from a
 * question nobody asked.
 *
 * It happened on the first real server run: `entity.falling_block.is_trackable_by_script`
 * appeared nowhere in the log at all. Nothing about reading the code makes it visible, which is
 * why the guard is mechanical.
 */
test('every probe that reports on a timer registers for the completion wait', () => {
  const dir = join(ROOT, 'pack', 'scripts', 'probes');
  const offenders: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, name), 'utf8');
    const deferred = /system\.run(Interval|Timeout)/.test(source);
    // A `result(` call inside the file is only a hazard when something defers; a probe that
    // only *sets a scene* on a timer has nothing to lose.
    const reports = /\bresult\(/.test(source);
    if (deferred && reports && !source.includes('willReportLater')) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these report after a delay but do not call willReportLater(), so their rows would vanish: ${offenders.join(', ')}`,
  );
});

/**
 * And the ticking area has to be waited FOR, not merely claimed.
 *
 * The claim does not take effect in the tick it is issued. Claiming and immediately spawning is
 * still asking about an unloaded chunk — which is how the first real run turned three rows into
 * `LocationInUnloadedChunkError` and said nothing whatsoever about Bedrock.
 */
test('the battery waits for the chunk rather than only claiming it', () => {
  const main = readFileSync(join(ROOT, 'pack', 'scripts', 'main.ts'), 'utf8');
  assert.match(main, /claimTickingArea/);
  assert.match(main, /whenChunkIsLive/);
  const claimAt = main.indexOf('claimTickingArea(`');
  const waitAt = main.indexOf('whenChunkIsLive(');
  assert.ok(claimAt !== -1 && waitAt !== -1 && waitAt > claimAt, 'the wait must come after the claim');
});

// ---------------------------------------------------------------------------
// The attachable, which is the rig this pack has broken most often
// ---------------------------------------------------------------------------

const attachables = paths.filter((p) => p.startsWith('RP/attachables/'));

/**
 * THE TWO SHAPES THAT RENDERED NOTHING, and neither of them errors.
 *
 * An attachable whose `textures` map has no `default` entry draws NOTHING — not the wrong colour,
 * not a missing-texture checker, nothing — and so does a `part_visibility` list starting
 * `{"*": false}` that never gets overridden. Both cost a session, and guessing which one it was
 * cost the session after that. Neither is visible in a build log, in a validation pass, or in the
 * game's own output.
 */
test('every attachable declares a default texture and a default geometry', () => {
  assert.ok(attachables.length >= 4, `only ${attachables.length} attachables emitted`);
  for (const path of attachables) {
    const description = json(path)['minecraft:attachable'].description;
    assert.ok(description.textures?.default, `${path} has no default texture — this renders as nothing`);
    assert.ok(description.geometry?.default, `${path} has no default geometry — this renders as nothing`);
    assert.ok(description.render_controllers?.length, `${path} names no render controller`);
  }
});

test('no attachable uses part_visibility, which is the other way to render nothing', () => {
  for (const path of attachables) {
    assert.ok(!JSON.stringify(json(path)).includes('part_visibility'), `${path} uses part_visibility`);
  }
  const controllers = paths.filter((p) => p.startsWith('RP/render_controllers/'));
  for (const path of controllers) {
    assert.ok(!JSON.stringify(json(path)).includes('part_visibility'), `${path} uses part_visibility`);
  }
});

/**
 * Every geometry and controller an attachable names has to be one this pack actually emits.
 *
 * A typo here does not fail the build and does not fail the game. It renders nothing, which is
 * indistinguishable from the finding the probe exists to report.
 */
test('every attachable points at a geometry and a controller that exist', () => {
  const geometries = new Set<string>();
  for (const path of paths.filter((p) => p.endsWith('.geo.json'))) {
    for (const model of json(path)['minecraft:geometry']) geometries.add(model.description.identifier);
  }
  const controllers = new Set<string>();
  for (const path of paths.filter((p) => p.includes('render_controllers/'))) {
    for (const name of Object.keys(json(path).render_controllers)) controllers.add(name);
  }
  for (const path of attachables) {
    const description = json(path)['minecraft:attachable'].description;
    for (const identifier of Object.values(description.geometry as Record<string, string>)) {
      assert.ok(geometries.has(identifier), `${path} names geometry "${identifier}", which is not emitted`);
    }
    for (const name of description.render_controllers as string[]) {
      assert.ok(controllers.has(name), `${path} names controller "${name}", which is not emitted`);
    }
  }
});

/**
 * Molang operator precedence eats array subscripts.
 *
 * `Array.palette[math.mod(x, 4)]` is the shape that has already gone wrong in a sibling repository:
 * an unparenthesised expression inside a subscript binds in a way nobody predicts, and the result
 * is a flag drawing the wrong colour rather than an error. A wrong colour IS the measurement here.
 */
test('every candidate expression is parenthesised inside its array subscript', () => {
  const file = paths.find((p) => p.endsWith('probe_attach.render_controllers.json'))!;
  const controllers = json(file).render_controllers;
  const names = Object.keys(controllers);
  assert.equal(names.length, config.probes.attachable.candidates.length);
  for (const name of names) {
    for (const expression of controllers[name].textures as string[]) {
      assert.match(expression, /^Array\.palette\[\(.*\)\]$/, `${name}: "${expression}" is not parenthesised`);
    }
  }
});

/**
 * NOTHING IS OFFSET BY ZERO. The anchor is on the BODY.
 *
 * A neat row of flags near the pivot renders at hip height on the third-person model, and two of
 * the four sit inside the torso. The rig works perfectly and cannot be read — which has happened
 * to this apparatus twice, on two different probes, for this one reason.
 */
test('no probe geometry sits on the attachment pivot', () => {
  for (const path of paths.filter((p) => p.endsWith('.geo.json') && !p.includes('probe_box'))) {
    for (const model of json(path)['minecraft:geometry']) {
      for (const bone of model.bones) {
        for (const cube of bone.cubes ?? []) {
          const [, y] = cube.origin as number[];
          // The stub is the deliberate exception: it exists AT the hand so that "controllers run,
          // queries do not" looks different from "nothing rendered at all".
          if (bone.name === 'stub') continue;
          assert.ok(y! > 0, `${path}: bone "${bone.name}" sits at y=${y}, where the body occludes it`);
        }
      }
    }
  }
});

/**
 * The pose rig's whole value is that the minimal rig is its control.
 *
 * If both declare animations, or neither does, there is nothing to compare and the row cannot be
 * answered — a person would be looking at one cube and asked whether it looks posed, which is a
 * judgement rather than a reading.
 */
test('the pose rig declares hold animations and its control declares none', () => {
  const posed = json(attachables.find((p) => p.includes('att_pose'))!)['minecraft:attachable'].description;
  const control = json(attachables.find((p) => p.includes('att_min'))!)['minecraft:attachable'].description;
  assert.ok(posed.animations, 'the pose rig declares no animations, so it is the same as its control');
  assert.ok(posed.scripts?.animate, 'the pose rig declares animations but never plays them');
  assert.ok(!control.animations, 'the control declares animations, so nothing differs between the two');
  // Same geometry, or the difference could be the model rather than the pose.
  assert.deepEqual(posed.geometry, control.geometry, 'the two rigs draw different models');
});

/**
 * The numbers that make the differential readable, refused when they stop being readable.
 *
 * The apparatus has already produced one picture nobody could grade: with `2048 % 4 == 0`, an
 * undamaged item shows exactly what a blind query shows. The validator reproduces the arithmetic
 * so that a changed damage cannot quietly reintroduce it.
 */
test('attachable damages that make the picture ungradeable are refused', () => {
  assert.deepEqual(validatePackConfig(config), []);

  const undamaged: PackConfig = {
    ...config,
    probes: { ...config.probes, attachable: { ...config.probes.attachable, damage: 0 } },
  };
  assert.match(validatePackConfig(undamaged).join('\n'), /also what a blind query returns|cannot be told apart/);

  const noDifferential: PackConfig = {
    ...config,
    probes: {
      ...config.probes,
      attachable: { ...config.probes.attachable, damage_b: config.probes.attachable.damage + 4 },
    },
  };
  assert.match(
    validatePackConfig(noDifferential).join('\n'),
    /indistinguishable from a blind one/,
    'a damage_b four apart reads identically and was accepted',
  );
});

// ---------------------------------------------------------------------------
// The stash
// ---------------------------------------------------------------------------

/**
 * A same-session fetch must NOT hand the item back.
 *
 * The reload row needs a stash that is still stashed when the world comes back up. A fetch that
 * spends it the moment somebody tries it out destroys the only setup that can answer the question,
 * and nothing about the readout would say so.
 */
test('the stash is not spent by a fetch in the same session', () => {
  const source = readFileSync(join(ROOT, 'pack', 'scripts', 'probes', 'stash.ts'), 'utf8');
  const sameSession = source.slice(source.indexOf('if (!reloaded)'), source.indexOf('if (!stored)'));
  assert.ok(sameSession.length > 0, 'the same-session branch has gone');
  assert.ok(!/addItem\(|spawnItem\(/.test(sameSession), 'a same-session fetch hands the item back');
  assert.match(sameSession, /skipped\(ctx, ROWS\.reload/, 'a same-session fetch reports the reload row anyway');
});

/**
 * The reload token cannot come from a clock.
 *
 * `Date.now()` at module scope makes the whole pack depend on `Date` existing in Bedrock's script
 * engine — and a throw there takes down every probe, not this one. The counter is bumped from
 * `worldLoad`, which fires once per load by definition.
 */
test('the stash session token is a load counter rather than a clock', () => {
  const source = readFileSync(join(ROOT, 'pack', 'scripts', 'probes', 'stash.ts'), 'utf8');
  // Comments stripped first: the file explains at length why it does not read a clock, and a check
  // that fires on its own rationale is one somebody deletes rather than fixes.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Date\.now\(\)|new Date\(/.test(code), 'the stash reads a clock');
  assert.match(code, /worldLoad\.subscribe/, 'nothing increments the load counter');
});

/** The fetch has to be reachable, or the stash sets up an experiment nobody can conclude. */
test('the stash follow-up is registered', () => {
  const main = readFileSync(join(ROOT, 'pack', 'scripts', 'main.ts'), 'utf8');
  assert.match(main, /'stash\.fetch'/, 'the fetch follow-up is not registered');
});
