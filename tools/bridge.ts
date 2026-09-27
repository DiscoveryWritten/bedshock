/**
 * The bridge: stand in for the script debugger a Bedrock client connects to, and keep what the
 * script engine prints. A live game on a phone becomes the same thing a dedicated server gives
 * the harness -- a log -- with nothing added to the pack.
 *
 *   bedshock bridge                     listen (on this machine's tailnet address by default)
 *   bedshock bridge send <command...>   run a command in the connected game
 *
 * In the game: Settings -> Creator -> Attach Debugger on Load, mode Connect, Host this machine,
 * Port 19144. Every `console.warn` the battery writes arrives here as a print, exactly as it would
 * in a server log, and goes to bridge/<time>.log. That file is an ordinary battery log:
 *
 *   bedshock collect bridge/<time>.log --version <client version> --platform client
 *
 * Nothing here records anything; recording stays the deliberate step it already was.
 *
 * THE PROTOCOL is Mojang's, read from their debugger (github.com/Mojang/minecraft-debugger,
 * src/session.ts and src/protocol-events.ts). Each message is its byte length in eight hex digits
 * and a newline, then one line of JSON. The game opens with its protocol version and the script
 * packs it is running; we answer with the version and the pack to attach to. Everything else here
 * is only what a log needs: prints in, commands out, never stop on anything.
 *
 * Commands come in on a control port bound to 127.0.0.1 only, so the one thing that can drive the
 * game is something already on this machine.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer as createHttp, request } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

/** The port the game's Creator settings offer by default. */
export const PORT = 19144;
export const CONTROL = 19145;

/** bedshock's script module, from content/pack.yaml -- attached to by default when present. */
export const BEDSHOCK_SCRIPT = 'b4164069-329a-47f1-be3e-00daaaac5fbb';

// --- framing ----------------------------------------------------------------------------------------

export function frame(message: unknown): Buffer {
  const json = Buffer.from(`${JSON.stringify(message)}\n`);
  return Buffer.concat([Buffer.from(`${json.byteLength.toString(16).padStart(8, '0')}\n`), json]);
}

/** Bytes in, whole messages out, however the stream happens to split them. */
export class Deframer {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 9) {
      const length = parseInt(this.buf.subarray(0, 9).toString(), 16);
      if (!Number.isFinite(length)) throw new Error('lost the frame boundary: not a length prefix');
      if (this.buf.length < 9 + length) break;
      out.push(JSON.parse(this.buf.subarray(9, 9 + length).toString()));
      this.buf = this.buf.subarray(9 + length);
    }
    return out;
  }
}

// --- the handshake ----------------------------------------------------------------------------------

export interface Plugin {
  name: string;
  module_uuid: string;
}

/**
 * Which script pack to attach to: the one asked for (by name or uuid), else bedshock, else the only
 * one there is. Undefined attaches to nothing, which still carries prints on the versions tried.
 */
export function chooseTarget(plugins: Plugin[], want?: string): Plugin | undefined {
  if (want) return plugins.find((p) => p.module_uuid === want || p.name.toLowerCase().includes(want.toLowerCase()));
  return plugins.find((p) => p.module_uuid === BEDSHOCK_SCRIPT) ?? (plugins.length === 1 ? plugins[0] : undefined);
}

/** The command message changed shape at protocol 5 and back at 8 -- the debugger's own rule. */
export function commandMessage(version: number, command: string) {
  const c = command.trim().replace(/^\//, '');
  return version < 5 || version >= 8
    ? { type: 'minecraftCommand', command: c, dimension_type: 'overworld' }
    : { type: 'minecraftCommand', command: { command: c, dimension_type: 'overworld' } };
}

/** This machine's tailnet address, so the bridge is reachable from your devices and nothing else. */
export function defaultHost(): string {
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0] || '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
}

// --- the server -------------------------------------------------------------------------------------

export interface BridgeOptions {
  host?: string;
  port?: number;
  control?: number;
  dir?: string;
  /** Script pack to attach to, by name or module uuid. */
  target?: string;
  passcode?: string;
  say?: (line: string) => void;
}

export interface Attached {
  log: string;
  version: number;
  plugins: Plugin[];
  target?: Plugin;
}

export interface Bridge {
  /** Resolves when a game has connected and been answered. */
  ready: Promise<Attached>;
  close(): Promise<void>;
}

export function serve(opts: BridgeOptions = {}): Bridge {
  const host = opts.host ?? defaultHost();
  const port = opts.port ?? PORT;
  const dir = opts.dir ?? 'bridge';
  const say = opts.say ?? ((l: string) => process.stdout.write(`${l}\n`));
  mkdirSync(dir, { recursive: true });

  let game: { socket: Socket; version: number } | undefined;
  let attached!: (a: Attached) => void;
  const ready = new Promise<Attached>((r) => (attached = r));

  const attach = (socket: Socket) => {
    const log = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const write = (line: string) => {
      mkdirSync(dir, { recursive: true });
      appendFileSync(log, `${line}\n`);
      say(line);
    };
    const send = (m: unknown) => socket.write(frame(m));
    const frames = new Deframer();
    say(`connection from ${socket.remoteAddress}`);

    let first = true;
    socket.on('data', (chunk) => {
      // A browser pointed at the bridge is the quickest test that a device can reach it at all, so
      // answer it plainly instead of failing it as a broken frame.
      if (first && /^(GET|HEAD|POST) /.test(chunk.toString('latin1', 0, 5))) {
        socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nbedshock bridge reachable. This is not the game; point Minecraft here.\n');
        say(`a browser reached the bridge from ${socket.remoteAddress} -- the network path works`);
        return;
      }
      first = false;
      let messages: unknown[];
      try {
        messages = frames.push(chunk);
      } catch (err) {
        write(`BEDSHOCK NOTE bridge: ${String(err)}; closing`);
        socket.destroy();
        return;
      }
      for (const m of messages as { type?: string; event?: any }[]) {
        const e = m.type === 'event' ? m.event : undefined;
        if (!e) continue;
        if (e.type === 'ProtocolEvent') {
          const plugins: Plugin[] = e.plugins ?? [];
          const target = chooseTarget(plugins, opts.target);
          send({
            type: 'protocol',
            version: e.version,
            ...(target ? { target_module_uuid: target.module_uuid } : {}),
            ...(opts.passcode ? { passcode: opts.passcode } : {}),
          });
          // A log is the whole point. Nothing here should ever be able to pause the game.
          send({ type: 'stopOnException', stopOnException: false });
          game = { socket, version: e.version };
          write(
            `BEDSHOCK NOTE bridge attached: protocol ${e.version}, target ${target?.name ?? 'none'}, ` +
              `packs ${plugins.map((p) => p.name).join(', ') || 'none'}` +
              (e.require_passcode && !opts.passcode ? ' -- a passcode was asked for and none given (--passcode)' : ''),
          );
          attached({ log, version: e.version, plugins, ...(target ? { target } : {}) });
        } else if (e.type === 'PrintEvent') {
          for (const line of String(e.message).split('\n')) if (line) write(line);
        } else if (e.type === 'StoppedEvent') {
          send({ type: 'resume' });
        }
      }
    });
    socket.on('close', () => {
      if (game?.socket === socket) game = undefined;
      say('game disconnected');
    });
    socket.on('error', () => {});
  };

  const server = createServer(attach);
  server.listen(port, host);

  const control = createHttp((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/command') {
        res.statusCode = 404;
        return res.end('POST /command with the command as the body\n');
      }
      if (!game) {
        res.statusCode = 409;
        return res.end('no game is connected\n');
      }
      // The protocol sends commands and returns nothing; what they cause arrives as prints.
      game.socket.write(frame(commandMessage(game.version, body)));
      res.end(`sent: ${body.trim()}\n`);
    });
  });
  control.listen(opts.control ?? CONTROL, '127.0.0.1');
  say(`bridge listening on ${host}:${port} -- in game, Creator settings: Connect, Host ${host}, Port ${port}`);


  return {
    ready,
    close: () =>
      new Promise((resolve) => {
        game?.socket.destroy();
        control.close();
        server.close(() => resolve());
      }),
  };
}

/** `bedshock bridge send ...`: hand one command to a running bridge. */
export function send(command: string, control = CONTROL): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: control, method: 'POST', path: '/command' }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => resolve(out.trim()));
    });
    req.on('error', () => reject(new Error(`no bridge on 127.0.0.1:${control} -- start one with \`bedshock bridge\``)));
    req.end(command);
  });
}
