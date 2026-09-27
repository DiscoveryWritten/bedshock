# The harness: measuring a client, on hardware, from a station

> `status: transport built, unmeasured on a device` — the transport is `bedshock bridge`, and
> it is not the one this document first proposed. It has passed a fake game in `tools/bridge.test.ts`
> and has not yet met a real client.

## The transport, as built: the script debugger, not `/connect`

**Updated 2026-09-27.** The `/connect` design below needed the pack to *say* every fact into chat,
chunked and encoded so chat could not mangle it, with a handshake to find which chat channel a
socket even hears. It works on paper and it is not elegant: the channel is chat, so everything
else has to fight chat.

The client has a better egress in the same Creator settings: **the script debugger.** With *Attach
Debugger on Load* in *Connect* mode, the game dials out to a host and port and speaks the
protocol of Mojang's own debugger (github.com/Mojang/minecraft-debugger). That protocol carries,
among other things:

| direction | message | what it carries |
|---|---|---|
| **out** | `ProtocolEvent` | the protocol version, and the script packs running |
| **out** | `PrintEvent` | **every line the script engine prints** — `console.warn` included |
| **in** | `minecraftCommand` | any slash command, `/scriptevent` included |
| **in** | `resume`, `stopOnException` | how a log-only debugger makes sure it can never pause the game |

So a battery running on a phone produces **exactly the lines a dedicated server's log does**, with
nothing added to the pack. `bedshock bridge` listens on this machine's tailnet address, attaches
to the bedshock script module, writes `bridge/<time>.log`, and `bedshock collect <log>
--platform client` records it like any other log. `bedshock bridge send <command>` drives the game
through a control port bound to `127.0.0.1`.

What it still cannot do is unchanged, and the rest of this document still governs it: it cannot
see a frame, cannot quit or kill the app, and **a live channel does not reclassify an eyes-only
row** (below).

The `/connect` design follows as it was written, because the reasoning about what a client
channel may settle is independent of which channel it is.

## The premise that changed

`anscode.ts` opens with a constraint it calls absolute, and it was right to:

> `@minecraft/server-net` says so in its own description: *"This module can only be used on
> Bedrock Dedicated Server."* A client add-on has no HTTP, no socket, no egress of any kind.
> Nothing a person plays on can report anywhere. So on a device with no terminal beside it —
> **an iPad**, a console — the only channel out of the game is the screen, and the only reader
> is a human or a photograph of one.

That is why the answer code exists, why it is Crockford base32, why it is checksummed, and why
`bedshock redeem` is as paranoid as it is. It is also why `Platform` has had a `client` value
since the first commit and why every `client` row in the ledger was typed in by a person.

**The client's own `/connect` is an egress the add-on API does not have.** It is not
`server-net` and it does not give scripts a socket. It is the *client* dialling out to a
WebSocket server that may subscribe to game events and issue commands as the player. Enabling
it is a Creator setting on the device, not a pack capability.

So the sentence stays true — an add-on still cannot report anywhere — and stops being the end
of the story, because the game around the add-on now can.

## What the channel actually is, precisely

Being exact about this matters, because the failure mode of an exciting new channel is
believing it does more than it does.

| direction | mechanism | what it carries |
|---|---|---|
| **in** | `commandRequest` over the socket | any slash command as the player — including `/scriptevent`, which is how every existing probe is already triggered |
| **out** | event subscription | a fixed, engine-defined set: chat, block placed/broken, item used, travelled, teleported, and friends |
| **out** | command responses | whatever the command itself returns |

The bridge to a pack's own voice is the same trick `composable-portals`' smoke test already
plays against a dedicated server's log, moved onto a client: **script writes to chat, chat
arrives as an event.** `CPSELFTEST PASS …` printed to chat is a measurement leaving a client.

What it is **not**: a way to read a pack's internal state directly, a way to see a frame, or a
way for a script to call out. Every fact still has to be *said* by something.

## The residency is for the process, and asks for no shelf space

Worth stating plainly, because every residency written before this one asks for a wing and an
absent block reads the same as a forgotten one.

`RESIDENCY.md` permits not asking, in one word — *"anything mounted as `.<name>-engine` **may**
hold a wing"* — and then never discusses it, because nothing had turned up that didn't want one.
This engine doesn't, and each of the three things a wing is normally for misses in a different
way:

| | why not a wing |
|---|---|
| **the output** | `ledger/observations.jsonl` is **git-tracked in this repository**, and consumers read it out of a pinned submodule — `composable-portals` runs `bedshock check` against `.bedshock/`. Git already solved distribution, and solved it better: a pin is a version, a wing is a copy. A `ledger` label would be a second home for one fact, and the worse of the two, because the one in git is the one that gets cited |
| **the scratch** | server downloads, unpacked worlds, captures. Hundreds of megabytes, none of it durable, none of it anybody's holding. A process needs somewhere to put this; it does not need shelf space, and putting transient rubbish in a place whose whole purpose is that things are kept is a category error |
| **the queue** | derived, not stored — the catalog says which questions need a client, the ledger says which are answered, the orders are the difference. Two files that exist. A third would be a copy that can drift |

What is left is the node's half and only the node's half. `RESIDENCY.md`'s own three-party table
says the node owns **the CPU, the clock, and the credential** and answers *does anything run at
all?*, while the library owns what is held. **This engine wants a landlord for its process and
none for its output.**

That the two requests travel in one file turns out to be a convenience of the format rather than
a claim that they belong together — and the scratch is the proof, because it is a real need that
is answered by a **binding**, not a holding. `{scratch}` sits alongside `.proofing-engine`'s
`{profile}` and `.ablative-engine`'s `{interface}`: a value the host knows and the resident
cannot guess.

### The one thing that might yet want a wing

A capture is evidence for a human's reading of an eyes-only question. DESIGN §5 makes `bedshock
amend` the only path from such a question into the ledger — and a person's pick is currently
backed by **nothing a second person could look at.** If that evidence should outlive the session,
it stops being scratch and becomes a holding with a disposition, and this residency grows a
`wants:` block after all.

Open, deliberately. It is treated as transient until somebody decides otherwise, because the
cheaper mistake is throwing away a recording of a game.

## Why this belongs to bedshock and not to a pack

Because the thing being measured is Bedrock, not the add-on. A pack that grew its own client
rig would be measuring the client in order to test itself, and the measurements would live
wherever that pack keeps its tests — which is the arrangement this whole repository exists to
replace. The battery asks the questions; the packs cite the answers.

It also means the queue needs no list. **The orders are derived**: the catalog already says
which questions need a client rather than a server, and the ledger already says which of those
are answered for a version. The work order is the difference between two files that exist.
A second registry would be a copy that can drift.

## The grant

The shape is Stagecraft's, deliberately, because a human authorising one device to be piloted
by another is the same act in both. What differs is *where the human is standing*, and each
difference moves a gate.

### Stagecraft, for reference

The operator holds a long machine-held `token`. `/pair` (which requires it) mints a short,
expiring, single-use code. A human **at the peer machine** opens `http://{address}:{port}/{code}`
in a browser. **Opening the page is the grant**, and it lives as long as the page is open.

### Here, and the three things that move

**1. The human is at the station, not at the device.** Stagecraft's code exists so that
"somebody already trusted may make a way in for somebody else." Here the operator and the
consenting human are one person at one desk, so there is no consent to transfer.

The code survives, for a different job: it binds *this socket* to *that pending grant*, so a
second client cannot answer a dial that was meant for the iPad. **Which changes the expiry.** A
consent-transfer code should live long enough to walk to another desk. A session-binding code
should be dead in under a minute, and long-lived codes are the smell that the two jobs got
confused.

**2. USB is the trust boundary, and it is better than a LAN — but only if the socket uses it.**

This is the crux, and it is easy to get wrong in a way that looks fine. `/connect` goes over the
network stack. If the gateway binds a LAN address, then *any* Minecraft on the house wifi can
redeem the code, and the physical guarantee the cable seemed to buy was never spent.

So: **bind loopback and reach the device through the cable** — a usbmuxd forward, the transport
`iproxy` already uses for iOS over USB. Then:

- the gateway has no LAN surface, so "trust the LAN" is not a question anyone has to answer;
- reachability **is** proof of attachment, so device identity needs no credential;
- unplugging is revocation, physically, with no policy involved and nothing to time out.

That collapses two gates into one and it is strictly stronger than a typed code.

> **The one unverified thing the whole shape rests on.** usbmuxd's well-trodden direction is
> host → device. This wants device → host: a Bedrock client on iOS dialling a host reachable
> *only* over the cable. Nobody has plugged the device in. **It is a capability, so it gets
> written as one and measured rather than assumed** — which is the entire discipline of this
> repository applied to its own harness. If it comes back NO, the fallback binds an address,
> the code carries the weight, and the cable is demoted from transport to witness: read the
> device's syslog over USB and admit only a socket whose connect attempt appears in it.

**3. App focus is the liveness gate, and it is mostly self-enforcing.** A browser tab closing
revokes a Stagecraft grant for free, because the socket dies with it. The equivalent chain here
is nearly as good and for a better reason: iOS suspends backgrounded apps, so *Minecraft losing
focus kills the socket by itself within seconds*. Closed, backgrounded, or unplugged all reduce
to the same observable.

**So do not implement focus as a separate check.** Treat socket liveness as the grant and let
the platform be the mechanism. Read focus over USB only to produce a *reason* — "Minecraft went
to background" rather than "socket closed" is the difference between a diagnosis and a shrug.

## The hazard this particular device brings

The donated iPad has a broken screen that **fires touch events from one corner**. Two
consequences, and both are measurement problems rather than annoyances:

- **Grants will lapse spuriously.** A phantom touch that reaches a home gesture or a
  notification backgrounds the app and drops the socket. A lapsed grant must therefore be
  **retryable and unremarkable**, never a failed run. Anything that treats it as a failure will
  cry wolf constantly and then be ignored at the moment it matters.
- **The piloted client has a second, uninvited pilot.** Phantom touches are input. Any question
  whose reading depends on the player not having moved is contaminated by a pilot nobody can
  see. The mitigation is the one this repository already reaches for: **make the reading
  differential.** Read position continuously, discard runs that drifted, and prefer a question
  whose two answers differ in what the game *says* over one whose answers differ in where the
  player *is*.

## What a capture is allowed to settle, which is less than it looks like

A USB-attached device can be screen-recorded, so the harness can produce a picture — and it is
tempting to read that as "rendering is measurable now." It is not, and DESIGN §5 is the reason:
**`LOOK` is not a result and cannot be made into one.** `run.ts` refuses a `RESULT` line for a
capability the catalog marks `observed`, and the only path from an eyes-only row into the ledger
runs through `bedshock amend`, where a person picks from an enumerated answer space.

The cautionary tale in DESIGN §6 is exactly this trap: a rig whose two candidate readings
produced a **pixel-identical picture**, for structural reasons baked in from the first version.
Two sessions were lost to it. A capture would not have helped; a differential reading did.

So the rule the harness ships with, and it should be the loud one:

> **A pilot may not reclassify a question by existing.** A row the catalog marks `observed`
> stays eyes-only until a person reclassifies it, one question at a time, with an argument about
> why its outcomes are now differential. Piloted rows carry their own `method` so the ledger can
> always say which is which.

This is the discipline most likely to be eroded quietly by an exciting new capability, which is
why it is written down before the capability is built rather than after it is abused.

Captures remain useful for what they honestly are: **evidence attached to a human's reading**,
and a record that survives the session so a second person can disagree with the first.

## What is open

- **The transport.** Built on the script debugger (above), tested against a fake game, not yet
  met by a real client. Unknowns a first real session answers: whether prints arrive from the
  attached pack only or from all of them; whether *Attach on Load* holds world load until a
  debugger answers; and which client version to record against, since the protocol does not say.
- **`kind: attended`.** No host implements a job that waits for a grant. `.library-engine`'s
  `RESIDENCY.md` has the same shape already in `kind: periodic` and says plainly what to do
  about it — *"a declaration a host has not implemented is legible and refusable… it should be
  petitioned for, not built around."* Petitioned, not built around.
- **Profiles.** `Platform` is `bds | client | imported`, which does not distinguish an iPad from
  a Windows box — and some of what a client rig is *for* is exactly that difference. Whether
  that is a fourth `Platform` value, a field beside it, or something the `api` string already
  implies is a ledger schema question and it is not answered here.
- **Who owns the queue.** The orders derive from catalog ∖ ledger, but *which* station has a
  profile and whether two could compete for one device is a node question, not a battery one.
- **Whether a capture is a holding.** Above. The answer decides whether this residency ever
  acquires a `wants:` block, and it is really a question about whether an eyes-only verdict owes
  anybody evidence.
