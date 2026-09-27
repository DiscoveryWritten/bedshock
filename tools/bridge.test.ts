/**
 * The bridge against a fake game that speaks the script debugger's protocol the way a client does:
 * introduces itself, prints a battery, takes a command. What comes out has to be a log `collect`
 * accepts, with nothing added to the pack to get it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BEDSHOCK_SCRIPT, chooseTarget, commandMessage, Deframer, frame, send, serve } from './bridge.ts';
import { collect } from './collect.ts';
import { loadCatalog } from './catalog.ts';

test('frames round-trip, however the stream splits them', () => {
  const messages = [{ a: 1 }, { b: 'two\nlines' }, { c: '§' }];
  const bytes = Buffer.concat(messages.map(frame));
  const d = new Deframer();
  const out: unknown[] = [];
  for (let i = 0; i < bytes.length; i += 5) out.push(...d.push(bytes.subarray(i, i + 5)));
  assert.deepEqual(out, messages);
  assert.match(frame({ a: 1 }).toString(), /^00000008\n\{"a":1\}\n$/);
});

test('the target is the one asked for, else bedshock, else the only pack there is', () => {
  const plugins = [{ name: 'Portal Arena', module_uuid: 'aaa' }, { name: 'bedshock', module_uuid: BEDSHOCK_SCRIPT }];
  assert.equal(chooseTarget(plugins)?.name, 'bedshock');
  assert.equal(chooseTarget(plugins, 'arena')?.module_uuid, 'aaa');
  assert.equal(chooseTarget([plugins[0]!])?.name, 'Portal Arena');
  assert.equal(chooseTarget([]), undefined);
});

test('the command shape follows the protocol version, as the debugger does', () => {
  assert.deepEqual(commandMessage(11, '/say hi'), { type: 'minecraftCommand', command: 'say hi', dimension_type: 'overworld' });
  assert.deepEqual(commandMessage(6, 'say hi'), { type: 'minecraftCommand', command: { command: 'say hi', dimension_type: 'overworld' } });
});

test('a browser gets a plain answer, so a reachability test reads as one', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = serve({ host: '127.0.0.1', port, control: port + 1, dir: mkdtempSync(join(tmpdir(), 'bridge-')), say: () => {} });
  const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(body, /bridge reachable/);
  await bridge.close();
});

test('a connected game becomes a log that collect records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const control = port + 1;
  const bridge = serve({ host: '127.0.0.1', port, control, dir, say: () => {} });

  const game = connect(port, '127.0.0.1');
  await new Promise((r) => game.once('connect', r));
  const received: any[] = [];
  const d = new Deframer();
  game.on('data', (c) => received.push(...d.push(c)));
  const event = (e: unknown) => game.write(frame({ type: 'event', event: e }));

  event({ type: 'ProtocolEvent', version: 11, plugins: [{ name: 'bedshock', module_uuid: BEDSHOCK_SCRIPT }] });
  const { log, target } = await bridge.ready;
  assert.equal(target?.name, 'bedshock');

  for (const message of [
    'BEDSHOCK BEGIN 2026-09-27T00:00:00.000Z',
    'BEDSHOCK RESULT storage.block.permutations_round_trip_exactly YES {"evidence":"every sampled symbol came back as itself"}',
    'BEDSHOCK DONE 1',
  ]) event({ type: 'PrintEvent', message, logLevel: 2 });
  event({ type: 'StoppedEvent', reason: 'exception', thread: 1 });

  assert.equal(await send('/scriptevent bedshock:probe storage', control), 'sent: /scriptevent bedshock:probe storage');
  await new Promise((r) => setTimeout(r, 150));

  assert.deepEqual(received.map((m) => m.type), ['protocol', 'stopOnException', 'resume', 'minecraftCommand']);
  assert.equal(received[0].target_module_uuid, BEDSHOCK_SCRIPT);
  assert.equal(received[3].command, 'scriptevent bedshock:probe storage');

  const collected = collect(readFileSync(log, 'utf8'), loadCatalog(), { version: '1.26.30', platform: 'client', run: 'bridge-test' });
  assert.ok(collected.complete, collected.problems.join('; '));
  assert.deepEqual(collected.observations.map((o) => o.capability), ['storage.block.permutations_round_trip_exactly']);

  game.destroy();
  await bridge.close();
});
