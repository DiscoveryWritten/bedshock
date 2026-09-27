/**
 * The bridge (tools/bridge.py) against a fake game that speaks the script debugger's protocol the
 * way a client does: introduces itself, prints a battery, stops, takes a command. What comes out has
 * to be a log `collect` accepts, with nothing added to the pack to get it.
 *
 * The bridge is system Python on purpose (see its header); this drives the real program, not a copy.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collect } from './collect.ts';
import { loadCatalog } from './catalog.ts';

const BEDSHOCK_SCRIPT = 'b4164069-329a-47f1-be3e-00daaaac5fbb';
const PYTHON = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';

const frame = (m: unknown) => {
  const body = Buffer.from(`${JSON.stringify(m)}\n`);
  return Buffer.concat([Buffer.from(`${body.length.toString(16).padStart(8, '0')}\n`), body]);
};

function deframe(buf: Buffer): unknown[] {
  const out: unknown[] = [];
  while (buf.length >= 9) {
    const n = parseInt(buf.subarray(0, 9).toString(), 16);
    if (buf.length < 9 + n) break;
    out.push(JSON.parse(buf.subarray(9, 9 + n).toString()));
    buf = buf.subarray(9 + n);
  }
  return out;
}

async function start(dir: string): Promise<{ bridge: ChildProcess; port: number; control: number }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const control = port + 1;
  const bridge = spawn(PYTHON, ['tools/bridge.py', '--host', '127.0.0.1', '--port', String(port), '--control', String(control), '--dir', dir]);
  await new Promise<void>((resolve, reject) => {
    bridge.stdout!.on('data', (d) => String(d).includes('listening') && resolve());
    bridge.once('exit', (code) => reject(new Error(`bridge exited ${code}`)));
  });
  return { bridge, port, control };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a browser gets a plain answer, so a reachability test reads as one', async () => {
  const { bridge, port } = await start(mkdtempSync(join(tmpdir(), 'bridge-')));
  try {
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /bridge reachable/);
  } finally {
    bridge.kill();
  }
});

test('a connected game becomes a log that collect records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  const { bridge, port, control } = await start(dir);
  try {
    const game = connect(port, '127.0.0.1');
    await new Promise((r) => game.once('connect', r));
    let received = Buffer.alloc(0);
    game.on('data', (c) => (received = Buffer.concat([received, c])));
    const event = (e: unknown) => game.write(frame({ type: 'event', event: e }));

    // Two packs, so the target has to be chosen: bedshock, by its script module.
    event({ type: 'ProtocolEvent', version: 11, plugins: [{ name: 'Portal Arena', module_uuid: 'aaa' }, { name: 'bedshock', module_uuid: BEDSHOCK_SCRIPT }] });
    for (const message of [
      'BEDSHOCK BEGIN 2026-09-27T00:00:00.000Z',
      'BEDSHOCK RESULT storage.block.permutations_round_trip_exactly YES {"evidence":"every sampled symbol came back as itself"}',
      'BEDSHOCK DONE 1',
    ]) event({ type: 'PrintEvent', message, logLevel: 2 });
    event({ type: 'StoppedEvent', reason: 'exception', thread: 1 });
    await wait(200);

    const res = await fetch(`http://127.0.0.1:${control}/command`, { method: 'POST', body: '/scriptevent bedshock:probe storage' });
    assert.equal((await res.text()).trim(), 'sent: /scriptevent bedshock:probe storage');
    await wait(200);

    const sent = deframe(received) as any[];
    // No stopOnException: protocol 10 answers it with "unhandled packet" (seen on an iPhone).
    assert.deepEqual(sent.map((m) => m.type), ['protocol', 'resume', 'minecraftCommand']);
    assert.equal(sent[0].target_module_uuid, BEDSHOCK_SCRIPT);
    // Protocol 8 and later take the flat command shape.
    assert.equal(sent[2].command, 'scriptevent bedshock:probe storage');

    const log = join(dir, readdirSync(dir)[0]!);
    const collected = collect(readFileSync(log, 'utf8'), loadCatalog(), { version: '1.26.30', platform: 'client', run: 'bridge-test' });
    assert.ok(collected.complete, collected.problems.join('; '));
    assert.deepEqual(collected.observations.map((o) => o.capability), ['storage.block.permutations_round_trip_exactly']);
    game.destroy();
  } finally {
    bridge.kill();
  }
});

test('with no game connected, a command is refused rather than lost', async () => {
  const { bridge, control } = await start(mkdtempSync(join(tmpdir(), 'bridge-')));
  try {
    const res = await fetch(`http://127.0.0.1:${control}/command`, { method: 'POST', body: 'say hi' });
    assert.equal(res.status, 409);
  } finally {
    bridge.kill();
  }
});
