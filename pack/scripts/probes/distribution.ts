/**
 * Did this pack get here without going through the content manager?
 *
 * THE CHEAPEST QUESTION IN THE BATTERY, and the one that decides how expensive every other one
 * is. On Bedrock an `.mcaddon` whose UUID is already installed is refused as a duplicate — the
 * old copy must be uninstalled and the client cached hard enough to need an app restart — so
 * every rebuild costs minutes of tapping before any measuring starts. A `.mcworld` that carries
 * its own packs never touches that list at all.
 *
 * HALF OF THIS IS ALREADY ANSWERED BY THE FACT THAT YOU ARE READING IT. If the battery responds
 * on a device that never installed the pack, world-local packs demonstrably work. The probe says
 * so plainly rather than pretending to test it, because a probe that ceremonially confirms its
 * own existence is theatre.
 *
 * The half that is genuinely open is whether importing ALSO registered the pack globally, and
 * only a person looking at a settings screen can answer that. Which is exactly the split this
 * battery is built around: script reports what it can see, and the one thing it cannot see goes
 * to a person with the answer space already enumerated.
 */

import { NAMESPACE, PACK_VERSION } from '../generated.ts';
import { look, type Ctx } from '../emit.ts';

const CAPABILITY = 'distribution.mcworld.carries_its_own_packs';

export function run(ctx: Ctx): void {
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
