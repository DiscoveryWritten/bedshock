/**
 * Building the answer code as a QR out of blocks, and standing you over it.
 *
 * WHY THIS AND NOT THE CODE ON ITS OWN. The code already solves getting answers off a client with
 * no network. What it does not solve is a THOUSAND PEOPLE: reading twenty-five characters off a
 * screen and passing them to somebody is fine when the somebody wrote the pack, and is not a
 * thing strangers do. A battery whose results depend on strangers transcribing is a battery that
 * collects nothing.
 *
 * A camera does not mistype. Point a phone at it — the one you are playing on, or another one
 * held up to the screen — and the URL opens.
 *
 * BUILT AT THE SITE, two hundred blocks up, for the same reason the chapters are: it is somewhere
 * nobody has been, nothing is standing, and the ground is whatever we put there. A QR laid on
 * terrain is a QR with grass in it.
 *
 * BLACK AND WHITE CONCRETE, not wool or terracotta. Concrete is the flattest, most saturated pair
 * Bedrock has — no pattern, no noise, no shading between neighbouring blocks of the same colour.
 * A scanner thresholds light against dark, and every bit of texture in a block face is contrast it
 * has to throw away.
 */

import { system, world, type Player, type Vector3 } from '@minecraft/server';

import { encode, footprint, QUIET, type Qr } from './qr.ts';
import { whenSiteIsLive, SITE } from './site.ts';
import type { Ctx } from './emit.ts';

const DARK = 'minecraft:black_concrete';
const LIGHT = 'minecraft:white_concrete';

/**
 * How far above the code the player is put.
 *
 * Far enough that the whole symbol is in frame, close enough that one module is still several
 * pixels wide in the photograph. A version 7 symbol is 53 blocks including its quiet zone; at this
 * height that lands well inside a phone's vertical field of view with margin for the HUD.
 */
const VIEWING_HEIGHT = 56;

/** Where the code is laid, clear of the chapter facilities that share the site. */
const PAD: Vector3 = { x: SITE.x, y: SITE.y, z: SITE.z + 80 };

export interface Built {
  ok: boolean;
  why?: string;
  /** Side length in blocks, quiet zone included. */
  side?: number;
}

/**
 * Lay the symbol down, row by row, and hand back where its centre is.
 *
 * ROW ORDER IS NORTH-TO-SOUTH AND WEST-TO-EAST, which matters: looking straight down with the
 * default camera puts north at the top of the screen, so a symbol built this way is the right way
 * up in the photograph. A QR read upside down still decodes — scanners rotate — but one built
 * transposed does not, because that is a mirror.
 */
function lay(qr: Qr, at: Vector3): Built {
  const dimension = world.getDimension('overworld');
  const side = footprint(qr);
  const half = Math.floor(side / 2);
  const originX = Math.floor(at.x) - half;
  const originZ = Math.floor(at.z) - half;
  const y = Math.floor(at.y);

  try {
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const mr = row - QUIET;
        const mc = col - QUIET;
        // Outside the matrix is the quiet zone, and it is BUILT rather than left to the world.
        // A scanner needs light all the way round to find the symbol's edges at all, and open
        // ground two hundred blocks up is air, which photographs as sky.
        const dark = mr >= 0 && mc >= 0 && mr < qr.size && mc < qr.size && qr.modules[mr]![mc]!;
        dimension.getBlock({ x: originX + col, y, z: originZ + row })?.setType(dark ? DARK : LIGHT);
      }
    }
  } catch (err) {
    return { ok: false, why: String(err).split('\n')[0] ?? 'unknown' };
  }
  return { ok: true, side };
}

/** Clear a previous code, so two sessions cannot leave two symbols overlapping. */
function clear(side: number, at: Vector3): void {
  const dimension = world.getDimension('overworld');
  const half = Math.floor(side / 2);
  for (let row = -half - 2; row <= half + 2; row++) {
    for (let col = -half - 2; col <= half + 2; col++) {
      try {
        dimension.getBlock({ x: Math.floor(at.x) + col, y: Math.floor(at.y), z: Math.floor(at.z) + row })?.setType('minecraft:air');
      } catch {
        /* outside the loaded area; the rebuild will overwrite what matters anyway */
      }
    }
  }
}

/**
 * Build the code as a QR and put the player above it, looking straight down.
 *
 * The URL is uppercased on the way in because QR's alphanumeric mode has no lowercase, and a
 * scheme and host are case-insensitive by specification. The PATH is not, which is why the
 * receiving end has to accept an uppercase code — and why the code's own alphabet is uppercase
 * Crockford base32 to begin with.
 */
export function show(ctx: Ctx, player: Player, url: string): void {
  let qr: Qr;
  try {
    qr = encode(url);
  } catch (err) {
    // Never silent, and never a partial symbol. A QR carrying half a URL scans perfectly and
    // sends somebody somewhere else.
    ctx.say(`§ecould not build the QR:§r ${String(err).split('\n')[0]}`);
    ctx.say('§7The code above still works — hand it over as text.§r');
    return;
  }

  whenSiteIsLive((live) => {
    if (!live) {
      ctx.say('§ethe site never loaded, so there is no QR.§r §7The code above still works as text.§r');
      return;
    }

    clear(footprint(qr) + 4, PAD);
    const built = lay(qr, PAD);
    if (!built.ok) {
      ctx.say(`§ecould not lay the QR:§r ${built.why}`);
      ctx.say('§7The code above still works — hand it over as text.§r');
      return;
    }

    // A tick to let the blocks actually exist before the camera is pointed at them.
    system.runTimeout(() => {
      try {
        player.teleport(
          { x: PAD.x, y: PAD.y + VIEWING_HEIGHT, z: PAD.z },
          // Straight down. `facingLocation` directly below is what makes it EXACTLY down rather
          // than approximately — a person told to "look down" produces a photograph at whatever
          // angle they stopped at, and a QR at an angle is a QR a scanner may or may not read.
          { facingLocation: { x: PAD.x, y: PAD.y, z: PAD.z } },
        );
      } catch {
        ctx.say(`§7could not move you — the code is at ${Math.floor(PAD.x)}, ${PAD.y}, ${Math.floor(PAD.z)}§r`);
      }
      ctx.say(`§a§lPOINT A CAMERA AT YOUR SCREEN.§r §7v${qr.version}, ${built.side} blocks across.§r`);
      ctx.say('§7Or screenshot it and scan the picture. Either opens a page with your answers in it.§r');
      console.warn(`BEDSHOCK NOTE qr v${qr.version} ${built.side} blocks at ${Math.floor(PAD.x)},${PAD.y},${Math.floor(PAD.z)}`);
    }, 10);
  }, PAD);
}
