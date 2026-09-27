#!/usr/bin/python3
"""bridge -- stand in for the script debugger a Bedrock client connects to, and keep what the
script engine prints. A live game on a phone becomes the same thing a dedicated server gives the
harness -- a log -- with nothing added to the pack.

    bedshock bridge                     listen on this machine's tailnet address
    bedshock bridge send <command...>   run a command in the connected game

In the game: Settings -> Creator -> Attach Debugger on Load, mode Connect, Host this machine's
tailnet address, Port 19144. Every line the battery prints arrives here exactly as it would in a
server log, and goes to bridge/<time>.log -- an ordinary battery log:

    bedshock collect bridge/<time>.log --version <client version> --platform client

Nothing here records anything; recording stays the deliberate step it already was.

THE PROTOCOL is Mojang's, read from their debugger (github.com/Mojang/minecraft-debugger,
src/session.ts and src/protocol-events.ts). Each message is its byte length in eight hex digits and
a newline, then one line of JSON. The game opens with its protocol version and the script packs it
is running; we answer with the version and the pack to attach to. The rest is only what a log
needs: prints in, commands out, never stop on anything.

Commands come in on a control port bound to 127.0.0.1 only, so the one thing that can drive the
game is something already on this machine. A browser pointed at the game port gets a plain answer,
as the quickest check that a device can reach it at all.

SYSTEM PYTHON, STDLIB ONLY, like this station's own services: it is the runtime this machine lets
accept connections, and it needs nothing installed. Python 3.9 -- no newer syntax.
"""

import json
import os
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 19144
CONTROL = 19145


def frame(message):
    body = (json.dumps(message, separators=(",", ":")) + "\n").encode()
    return ("%08x\n" % len(body)).encode() + body


def read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def choose_target(plugins, want=None):
    """The pack asked for, by name or uuid -- and by default, none.

    ATTACH TO NOTHING UNLESS ASKED. A debugger attached to a pack slows every line it runs: on an
    iPhone, attaching to bedshock gave "InternalError: interrupted" at load, a 6.4 s watchdog hang
    and a steady 160 ms slowdown. Prints arrive without attaching -- the whole content log does --
    so a bridge that only wants the log has no reason to attach.
    """
    if not want:
        return None
    for p in plugins:
        if p.get("module_uuid") == want or want.lower() in p.get("name", "").lower():
            return p
    return None


def command_message(version, command):
    """The command message changed shape at protocol 5 and back at 8 -- the debugger's own rule."""
    c = command.strip().lstrip("/")
    if version < 5 or version >= 8:
        return {"type": "minecraftCommand", "command": c, "dimension_type": "overworld"}
    return {"type": "minecraftCommand", "command": {"command": c, "dimension_type": "overworld"}}


def tailnet_address():
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5).stdout
        return out.split()[0] if out.split() else "127.0.0.1"
    except (OSError, subprocess.SubprocessError):
        return "127.0.0.1"


class Bridge:
    def __init__(self, host, port, control, log_dir, target=None, passcode=None):
        self.host, self.port, self.control, self.log_dir = host, port, control, log_dir
        self.target, self.passcode = target, passcode
        self.game = None  # (socket, protocol version)
        self.lock = threading.Lock()

    def say(self, line):
        print(line, flush=True)

    # --- one connection ---------------------------------------------------------------------------

    def handle(self, sock, addr):
        first = sock.recv(9, socket.MSG_PEEK)
        if first[:4] in (b"GET ", b"HEAD", b"POST"):
            # Read the request before answering: closing on unread data resets the connection, and
            # the browser shows a failure instead of the page.
            sock.recv(65536)
            text = b"bedshock bridge reachable. This is not the game; point Minecraft here.\n"
            sock.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n"
                         b"Connection: close\r\n\r\n%s" % (len(text), text))
            sock.shutdown(socket.SHUT_WR)
            sock.close()
            self.say("a browser reached the bridge from %s -- the network path works" % addr[0])
            return

        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
        log = os.path.join(self.log_dir, stamp + ".log")

        def write(line):
            os.makedirs(self.log_dir, exist_ok=True)
            with open(log, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            self.say(line)

        self.say("connection from %s" % addr[0])
        try:
            while True:
                header = read_exact(sock, 9)
                if header is None:
                    break
                try:
                    length = int(header.decode(), 16)
                except ValueError:
                    write("BEDSHOCK NOTE bridge: lost the frame boundary: not a length prefix; closing")
                    break
                body = read_exact(sock, length)
                if body is None:
                    break
                message = json.loads(body)
                event = message.get("event") if message.get("type") == "event" else None
                if not event:
                    continue
                kind = event.get("type")
                if kind == "ProtocolEvent":
                    version = event.get("version", 0)
                    plugins = event.get("plugins") or []
                    target = choose_target(plugins, self.target)
                    reply = {"type": "protocol", "version": version}
                    if target:
                        reply["target_module_uuid"] = target["module_uuid"]
                    if self.passcode:
                        reply["passcode"] = self.passcode
                    sock.sendall(frame(reply))
                    with self.lock:
                        self.game = (sock, version)
                    note = "BEDSHOCK NOTE bridge attached: protocol %s, target %s, packs %s" % (
                        version, target["name"] if target else "none",
                        ", ".join(p.get("name", "?") for p in plugins) or "none")
                    if event.get("require_passcode") and not self.passcode:
                        note += " -- a passcode was asked for and none given (--passcode)"
                    write(note)
                elif kind == "PrintEvent":
                    for line in str(event.get("message", "")).split("\n"):
                        if line:
                            write(line)
                elif kind == "StoppedEvent":
                    # A log is the whole point: nothing here may leave the game paused.
                    sock.sendall(frame({"type": "resume"}))
        except (OSError, ValueError) as err:
            self.say("connection error: %s" % err)
        finally:
            with self.lock:
                if self.game and self.game[0] is sock:
                    self.game = None
            sock.close()
            self.say("game disconnected")

    def send(self, command):
        with self.lock:
            game = self.game
        if not game:
            return False
        # The protocol sends commands and returns nothing; what they cause arrives as prints.
        game[0].sendall(frame(command_message(game[1], command)))
        return True

    # --- the two listeners ------------------------------------------------------------------------

    def serve(self):
        bridge = self

        class Control(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
                if self.path != "/command":
                    return self.reply(404, "POST /command with the command as the body")
                if not bridge.send(body):
                    return self.reply(409, "no game is connected")
                self.reply(200, "sent: " + body.strip())

            def reply(self, code, text):
                data = (text + "\n").encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        control = ThreadingHTTPServer(("127.0.0.1", self.control), Control)
        threading.Thread(target=control.serve_forever, daemon=True).start()

        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self.host, self.port))
        server.listen()
        self.say("bridge listening on %s:%d -- in game, Creator settings: Connect, Host %s, Port %d"
                 % (self.host, self.port, self.host, self.port))
        while True:
            sock, addr = server.accept()
            threading.Thread(target=self.handle, args=(sock, addr), daemon=True).start()


def send(command, control=CONTROL):
    req = urllib.request.Request("http://127.0.0.1:%d/command" % control, data=command.encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.read().decode().strip()
    except urllib.error.HTTPError as err:
        return err.read().decode().strip()
    except OSError:
        sys.exit("no bridge on 127.0.0.1:%d -- start one with `bedshock bridge`" % control)


def main(argv):
    opts, rest = {}, []
    i = 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    control = int(opts.get("control", CONTROL))
    if rest[:1] == ["send"]:
        if len(rest) < 2:
            sys.exit("usage: bedshock bridge send <command...>")
        print(send(" ".join(rest[1:]), control))
        return
    Bridge(
        host=opts.get("host") or tailnet_address(),
        port=int(opts.get("port", PORT)),
        control=control,
        log_dir=opts.get("dir", "bridge"),
        target=opts.get("target"),
        passcode=opts.get("passcode"),
    ).serve()


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        pass
