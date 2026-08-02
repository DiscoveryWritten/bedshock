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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { crossCheck } from './build.ts';
import { loadCatalog } from './catalog.ts';
import { loadPackConfig, validatePackConfig, type PackConfig } from './config.ts';
import { minimumRowSeparation, RULER_ROWS, glyphPage, rulerSprite, flipbookStrip } from './gen/assets.ts';
import { generatedModule, packFiles, probeIds } from './gen/pack.ts';
import { ROOT } from './paths.ts';

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
    'fallcurve', 'anvilgap', 'throw', 'knockback', 'repair', 'ruler', 'glyphs', 'flipbook',
    'formicon',
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
