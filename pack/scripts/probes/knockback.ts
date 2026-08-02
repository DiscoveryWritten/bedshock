/**
 * What is a unit of `applyKnockback` worth, in blocks?
 *
 * `applyKnockback` is the only way a script can impose momentum on a player — `applyImpulse`
 * refuses them — and its argument has no documented unit. So every use of it anywhere is a guess
 * calibrated by hand until it looked right, and every one of those guesses silently inherits
 * whatever the engine does with the number. This row is that calibration, written down.
 *
 * TWO ROWS, NOT ONE, and the split is the finding waiting to happen. The same call is made
 * against a player and against an ordinary entity, and there is no guarantee they move the same
 * distance: players have client-side movement, different friction and different step handling.
 * A momentum design that assumes one constant covers both is resting on a proposition nobody
 * checked, so it gets a row and can be checked.
 *
 * The player row can only be measured with a player present, and is skipped on a server. That is
 * not a gap to be embarrassed about: it is the honest shape of the question, and the entity row
 * running headless is what keeps the apparatus itself exercised between sessions.
 *
 * REST IS DETECTED BY POSITION, NOT VELOCITY. A player's movement is client-authoritative and
 * their reported velocity is not reliably the thing that moved them; where they ended up is. The
 * same test is used for the entity so the two rows differ in their subject and in nothing else.
 */

import { system, world, type Entity, type Vector3 } from '@minecraft/server';

import { PARAMS } from '../generated.ts';
import { SOLVES } from '../catalog.generated.ts';
import { arena, type Arena } from '../arena.ts';
import { firstLine, HEADLESS_AT, skipped, type Ctx } from '../emit.ts';
import { measure, type Record } from '../measure.ts';

const PLAYER = 'physics.knockback.blocks_per_unit';
const ENTITY = 'physics.knockback.blocks_per_unit_on_an_entity';

export function run(ctx: Ctx): void {
  const p = PARAMS.knockback;
  const at = ctx.player?.location ?? HEADLESS_AT;
  const dimension = ctx.player?.dimension ?? world.getDimension('overworld');
  const box = arena(at, { length: p.run_length, height: p.headroom, width: 2, behind: 2 }, dimension);

  // The entity row first: it runs everywhere, so a session that a person abandons half way
  // through has still produced the reading that does not need them.
  ask(ctx, ENTITY, box, () => {
    box.sweep(p.subject);
    return dimension.spawnEntity(p.subject, box.at(0, 1));
  });

  if (!ctx.player) {
    skipped(ctx, PLAYER, 'no player connected (headless run) — nothing to knock back');
    return;
  }
  const player = ctx.player;
  ask(ctx, PLAYER, box, () => {
    player.teleport(box.at(0, 0));
    return player;
  });
}

/**
 * Knock a subject and see how far it goes, several times.
 *
 * `summon` is called fresh for every reading and must hand back something standing at the
 * arena's origin — a newly spawned entity, or the player teleported back. A reading that started
 * from wherever the last one finished would measure the two together.
 */
function ask(ctx: Ctx, capability: string, box: Arena, summon: () => Entity): void {
  const spec = SOLVES.find((s) => s.id === capability);
  if (!spec) {
    skipped(ctx, capability, 'the catalog no longer declares this as a solved row');
    return;
  }
  const p = PARAMS.knockback;

  const reading = (_index: number, record: Record): void => {
    let subject: Entity;
    let from: Vector3;
    try {
      box.clear();
      const problem = box.verify();
      if (problem) {
        record(null, problem);
        return;
      }
      subject = summon();
      subject.clearVelocity();
      from = { ...subject.location };
      // Vertical zero deliberately. A knockback with lift travels much further, and mixing the
      // two would make the number depend on a choice made here rather than on the engine.
      subject.applyKnockback({ x: p.units, z: 0 }, 0);
    } catch (err) {
      record(null, `could not knock the subject back: ${firstLine(err)}`);
      return;
    }

    let ticks = 0;
    let still = 0;
    let last = from;
    let furthest = 0;

    const handle = system.runInterval(() => {
      ticks++;

      if (!subject.isValid) {
        system.clearRun(handle);
        record(null, `the subject stopped existing after ${ticks} tick(s)`);
        return;
      }

      let here: Vector3;
      try {
        here = subject.location;
      } catch (err) {
        system.clearRun(handle);
        record(null, `lost the subject mid-flight: ${firstLine(err)}`);
        return;
      }

      const step = Math.hypot(here.x - last.x, here.z - last.z);
      last = here;
      furthest = Math.max(furthest, Math.hypot(here.x - from.x, here.z - from.z));

      // REST ONLY COUNTS ONCE IT HAS MOVED, and this is the fix for a real run rather than a
      // precaution. Bedrock 1.26.36.1 lost all five readings here: the countdown began at tick
      // one, when the subject had of course not gone anywhere yet, and eight ticks later the
      // probe concluded it was at rest at the origin. A knockback applied in the tick a thing
      // spawned does not move it in that same tick -- so "has not moved yet" and "has stopped
      // moving" were the same state, and the apparatus could not tell a settled entity from an
      // immovable one.
      if (furthest < p.rest_step) {
        if (ticks < p.moved_by_ticks) return;
        system.clearRun(handle);
        if (subject.typeId === p.subject) subject.remove();
        // Now this reading means something: it really never moved, over the whole window.
        record(
          null,
          `the subject never moved at all under ${p.units} unit(s) of knockback, over ${ticks} tick(s). ` +
            `Knockback is an impulse — it acts at once or not at all — so this subject is immovable ` +
            `and the row needs a different one.`,
        );
        return;
      }

      still = step < p.rest_step ? still + 1 : 0;

      if (still >= p.rest_ticks) {
        system.clearRun(handle);
        const moved = Math.hypot(here.x - from.x, here.z - from.z);
        if (subject.typeId === p.subject) subject.remove();
        record(moved / p.units, `${round(moved)} blocks from ${p.units} unit(s), over ${ticks} tick(s)`);
        return;
      }

      if (ticks < p.watch_ticks) return;
      system.clearRun(handle);
      if (subject.typeId === p.subject) subject.remove();
      record(null, `still moving after ${ticks} tick(s), ${round(furthest)} blocks out`);
    }, 1);
  };

  measure(
    ctx,
    {
      capability,
      probe: 'knockback',
      unit: spec.unit,
      samples: p.samples,
      spread: p.spread,
      range: { from: spec.from, to: spec.to },
      cooldown: 8,
      readingTimeout: p.watch_ticks + 40,
    },
    reading,
  );
}

const round = (n: number): number => Number(n.toFixed(3));
