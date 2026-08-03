/**
 * Did this pack get here without going through the content manager?
 *
 * THE CHEAPEST QUESTION IN THE BATTERY, and the one that decides how expensive every other one
 * is. On Bedrock an `.mcaddon` whose UUID is already installed is refused as a duplicate — the
 * old copy must be uninstalled and the client cached hard enough to need an app restart — so
 * every rebuild costs minutes of tapping before any measuring starts. A `.mcworld` that carries
 * its own packs never touches that list at all.
 *
 * HALF OF THIS IS ALREADY ANSWERED BY THE FACT THAT YOU ARE READING IT — ON A CLIENT. If the
 * battery responds on a device that never installed the pack, world-local packs demonstrably
 * work.
 *
 * ON A DEDICATED SERVER THAT ARGUMENT IS WORTHLESS, and this probe used to make it anyway. A BDS
 * has no content manager: `bds.sh` installs by copying the pack into `behavior_packs/` on disk,
 * and a server loads it from there whatever the question's answer is. So "the battery answered at
 * all" was guaranteed on every headless run, and the probe emitted a LOOK asking somebody to go
 * and read `Settings > Storage` on a machine that has no settings screen.
 *
 * That is the same fault the anvil-clearance search had, on the row that can least afford it:
 * evidence that cannot come out the other way, underneath the one question that decides whether
 * updating this pack costs three minutes of tapping or none.
 *
 * So the probe now says WHICH ROUTE DELIVERED IT, and only asks the question of a run that could
 * have taken the route being asked about.
 */

import { world } from '@minecraft/server';

import { NAMESPACE, PACK_VERSION } from '../generated.ts';
import { look, skipped, type Ctx } from '../emit.ts';

const CAPABILITY = 'distribution.mcworld.carries_its_own_packs';

export function run(ctx: Ctx): void {
  // A player means a client, and a client is the only place a content manager exists. Not a
  // stand-in for "somebody is watching" -- it is the actual distinguishing fact, because the
  // route under test (import a world, touch nothing global) has no meaning on a server.
  if (!ctx.player && world.getAllPlayers().length === 0) {
    skipped(
      ctx,
      CAPABILITY,
      'headless run — a dedicated server loads packs from behavior_packs/ on disk and has no ' +
        'content manager, so nothing here was imported and this run says nothing about the import path',
    );
    return;
  }

  ctx.say(
    `§7running as§r ${NAMESPACE} ${PACK_VERSION}§7. If this device never installed the .mcaddon, ` +
      `world-local packs already work — that is what "the battery answered at all" means.§r`,
  );

  look(
    ctx,
    CAPABILITY,
    `the pack responded (${NAMESPACE} ${PACK_VERSION}). Now check Settings > Storage: ` +
      `is there a bedshock entry in the GLOBAL pack list? No entry is the good answer — it means ` +
      `nothing was installed, nothing accumulates, and the next update is delete-world-and-import.`,
  );
}
