/**
 * `/scriptevent bedshock:probe [what]` — the battery.
 *
 * With no argument it runs everything. With a probe name it runs one, which is what you want
 * when a single row needs re-reading and re-running the lot would bury it. Follow-ups use a dot:
 * `dynprops.token`, `container.clear`.
 *
 * WHAT THIS PACK IS. Nothing but instruments. It ships no gameplay and it is not meant to sit
 * in a world anyone cares about — several of its items are deliberately in the creative menu,
 * because whether they can be kept OUT of it is one of the questions. Install it, ask, record,
 * remove.
 *
 * IT RUNS HEADLESS TOO, and that is most of its value. The automated rows need no player, so
 * `tools/run.ts` boots a real Bedrock Dedicated Server, sends this event, and reads the answers
 * out of the log — no human, no client, and repeatable on every Minecraft version there is a
 * server build for. The rows that genuinely need eyes report why they were skipped rather than
 * being silently absent, because a silently absent probe is indistinguishable from one that
 * ran and found nothing, and only one of those is a finding.
 */

import { system, world, type Player } from '@minecraft/server';

import { NAMESPACE, PACK_VERSION } from './generated.ts';
import { begin, claimTickingArea, done, firstLine, makeCtx, whenChunkIsLive, type Ctx } from './emit.ts';
import * as durability from './probes/durability.ts';
import * as dynprops from './probes/dynprops.ts';
import * as container from './probes/container.ts';
import * as distribution from './probes/distribution.ts';
import * as offhand from './probes/offhand.ts';
import * as menu from './probes/menu.ts';
import * as anvilgap from './probes/anvilgap.ts';
import * as fallcurve from './probes/fallcurve.ts';
import * as knockback from './probes/knockback.ts';
import * as fallingblock from './probes/fallingblock.ts';
import * as repair from './probes/repair.ts';
import * as throwProbe from './probes/throw.ts';
import * as scenes from './probes/scenes.ts';
import * as attachable from './probes/attachable.ts';
import * as stash from './probes/stash.ts';
import * as session from './session.ts';
import * as chapter from './chapter.ts';
import * as kiosk from './kiosk.ts';

type Probe = (ctx: Ctx) => void;

/**
 * The registry, and the order is deliberate: everything that can answer without a player runs
 * first. A headless run then produces its findings before anything has a chance to throw for
 * want of hands, and a partial log is still a useful log.
 */
const PROBES: Record<string, Probe> = {
  durability: durability.run,
  menu: menu.run,
  dynprops: dynprops.run,
  container: container.run,
  offhand: offhand.run,
  fallingblock: fallingblock.run,
  fallcurve: fallcurve.run,
  // Last of the headless probes, and deliberately so: a solve is dozens of trials and takes
  // minutes where the others take ticks. Everything cheap has already reported by the time this
  // starts, so a run cut short still carries the rest of the battery.
  anvilgap: anvilgap.run,
  throw: throwProbe.run,
  knockback: knockback.run,
  repair: repair.run,
  distribution: distribution.run,
  ruler: scenes.ruler,
  glyphs: scenes.glyphs,
  flipbook: scenes.flipbook,
  formicon: scenes.formIcons,
  attachable: attachable.run,
  attachable_pose: attachable.pose,
  stash: stash.run,
};

/** Follow-ups: the halves of a measurement that cannot happen in one call. */
const FOLLOW_UPS: Record<string, (ctx: Ctx, player: Player) => void> = {
  'dynprops.stamp': dynprops.stamp,
  'dynprops.token': dynprops.token,
  'container.read': (ctx) => container.read(ctx),
  'container.clear': (ctx) => container.clear(ctx),
  // The half of the stash that has to happen AFTER something -- a walk, or a quit to title.
  // See `stash.ts` for why a same-session fetch deliberately does not spend the stash.
  'stash.fetch': (ctx) => stash.fetch(ctx),
};

/**
 * The guided run, and its own event rather than a probe.
 *
 * A probe SETS A SCENE and leaves; the session drives a person through many scenes and collects
 * what they saw. Sharing an entry point would blur the one distinction this pack is most careful
 * about — that a `LOOK` is not a result — because a session's output IS answers.
 */
const SESSIONS: Record<string, (ctx: Ctx, player: Player) => void> = {
  '': (ctx, player) => session.start(ctx, player, false),
  all: (ctx, player) => session.start(ctx, player, true),
};

/** Run one probe, surviving whatever it throws. */
function runOne(ctx: Ctx, name: string, probe: Probe): void {
  try {
    probe(ctx);
  } catch (err) {
    // One probe throwing must not take the battery with it. A run that dies halfway reports
    // nothing about the rows it never reached, and an absent row must never be recorded as a
    // negative one.
    console.warn(`BEDSHOCK ERROR ${name} ${firstLine(err)}`);
    ctx.say(`§c${name} threw:§r ${firstLine(err)}`);
  }
}

function playerOf(event: { sourceEntity?: { typeId: string } }): Player | undefined {
  return event.sourceEntity?.typeId === 'minecraft:player' ? (event.sourceEntity as Player) : undefined;
}

function runAll(ctx: Ctx): void {
  begin();
  ctx.say(`§l${NAMESPACE} ${PACK_VERSION}§r — capability battery`);
  for (const [name, probe] of Object.entries(PROBES)) runOne(ctx, name, probe);
  done(ctx);
}

system.afterEvents.scriptEventReceive.subscribe(
  (event) => {
    if (event.id === `${NAMESPACE}:session`) {
      const player = playerOf(event);
      if (!player) {
        makeCtx().say('a session needs a player — it is a guided run, not a measurement.');
        return;
      }
      const ctx = makeCtx(player);
      claimTickingArea(`${NAMESPACE}_probe`);
      const which = SESSIONS[event.message.trim()];
      if (!which) {
        ctx.say(`no session called "${event.message.trim()}". Try nothing, or \`all\`.`);
        return;
      }
      whenChunkIsLive(ctx, () => which(ctx, player));
      return;
    }

    // The guided build: one facility at a time, raised from nothing, left standing to be looked
    // at. See `chapter.ts` for why it is not one tall building and not shipped pre-built.
    if (event.id === `${NAMESPACE}:chapter`) {
      const player = playerOf(event);
      if (!player) {
        makeCtx().say('chapters are for a person to walk through — a server has nobody to show them to.');
        return;
      }
      const ctx = makeCtx(player);
      chapter.dispatch(ctx, PROBES, event.message, player);
      return;
    }

    // THE FACILITY BUILDER, CHECKED WITHOUT A PERSON. Raising a chapter needs no player -- only
    // walking it does -- so the riskiest part of the guided run can be exercised on a bare server
    // on every commit. Two hundred blocks up is somewhere nobody has ever stood, and whether a
    // ticking area comes up there and `setType` reads back is exactly the sort of thing that has
    // failed silently in this repository before.
    //
    // Apparatus rather than measurement, so it reports on its own channel and never emits a
    // RESULT. A chapter that cannot be built is a problem with the rig, and every reading taken
    // inside it would be a reading about the rig.
    if (event.id === `${NAMESPACE}:sitecheck`) {
      chapter.checkEveryBlueprint(makeCtx(playerOf(event)));
      return;
    }

    if (event.id === `${NAMESPACE}:code`) {
      session.showLastCode(makeCtx(playerOf(event)));
      return;
    }

    // THE WORLD THAT SHIPS MUST BE ONE NOBODY HAS RUN ANYTHING IN.
    //
    // `bds.sh` exports the world AFTER the battery has run in it, so every entity a probe spawned
    // travelled inside the `.mcworld` and greeted whoever imported it. Reported from a phone on
    // the first real run: a row of white boxes at spawn, in what was supposed to be a clean
    // environment. They were CI's container probes, eight of them, left where a headless run
    // dropped them.
    //
    // That is not untidiness. Those entities are apparatus, and a person could have opened one
    // and answered `entity.container.*` about a container this session never created — a reading
    // taken against somebody else's rig, which is the same failure as two probes sweeping each
    // other's arenas, one level up and shipped to a stranger.
    if (event.id === `${NAMESPACE}:teardown`) {
      const ctx = makeCtx(playerOf(event));
      const removed = container.clear(ctx);
      chapter.demolishEverything(ctx);
      // THE COUNT, not just the fact that it ran. A teardown that swept nothing and a teardown
      // that was never reached print the same line otherwise, and the battery always spawns
      // containers -- so zero here is a sweep that missed, which is the failure being fixed.
      console.warn(`BEDSHOCK NOTE teardown complete, removed ${removed} entit${removed === 1 ? 'y' : 'ies'}`);
      return;
    }

    if (event.id !== `${NAMESPACE}:probe`) return;

    const player = playerOf(event);
    const ctx = makeCtx(player);
    const what = event.message.trim();

    // Claim the area, then WAIT for it. The claim does not take effect in the tick it is
    // issued, and a battery that claims and immediately spawns is still asking about an
    // unloaded chunk -- which is how this battery's first real server run turned three rows
    // into LocationInUnloadedChunkError and said nothing about Bedrock at all.
    claimTickingArea(`${NAMESPACE}_probe`);

    if (what === '') {
      whenChunkIsLive(ctx, () => runAll(ctx));
      return;
    }

    const followUp = FOLLOW_UPS[what];
    if (followUp) {
      if (!player) {
        ctx.say('that follow-up needs a player.');
        return;
      }
      followUp(ctx, player);
      return;
    }

    const probe = PROBES[what];
    if (!probe) {
      ctx.say(
        `no probe called "${what}". Probes: ${Object.keys(PROBES).join(', ')}. ` +
          `Follow-ups: ${Object.keys(FOLLOW_UPS).join(', ')}`,
      );
      return;
    }

    whenChunkIsLive(ctx, () => {
      begin();
      runOne(ctx, what, probe);
      done(ctx);
    });
  },
  // Only our own namespace reaches the handler. Anything else is somebody else's event.
  { namespaces: [NAMESPACE] },
);

// THE WAY IN THAT IS NOT A CHAT COMMAND. A button, or the item you spawn holding. See kiosk.ts
// for why neither is matched against a remembered coordinate.
kiosk.install();

world.afterEvents.worldLoad.subscribe(() => {
  console.warn(
    `BEDSHOCK READY ${NAMESPACE} ${PACK_VERSION} — /scriptevent ${NAMESPACE}:probe, ` +
      `/scriptevent ${NAMESPACE}:session`,
  );
});
