/**
 * Running a chapter: raise the facility, run what needs it, stop so it can be looked at.
 *
 * The order and the contents live in `chapters.ts`, which imports no Minecraft so a build order
 * can be checked before anything is placed. This is only the part that needs a game.
 */

import { world, type Player } from '@minecraft/server';

import { validate } from './blueprint.ts';
import { CHAPTERS } from './chapters.ts';
import { site, whenSiteIsLive, SITE } from './site.ts';
import { outstandingProbes, whenSettled, type Ctx } from './emit.ts';

export { CHAPTERS, chapterNamed, type Chapter } from './chapters.ts';

/** Which chapter we are on, kept in the world so a session survives a disconnect. */
const AT = 'bedshock:chapter_at';

function indexNow(): number {
  const raw = world.getDynamicProperty(AT);
  return typeof raw === 'number' ? raw : 0;
}

function setIndex(n: number): void {
  world.setDynamicProperty(AT, n);
}

export type ProbeRegistry = Record<string, (ctx: Ctx) => void>;

export interface RunChapterOptions {
  /** Keep going into the next chapter instead of halting for a look. */
  sweep?: boolean;
}

/**
 * Build the chapter at `index`, run its probes, and stop.
 *
 * Demolition of the PREVIOUS chapter happens here rather than when it finished, which is what
 * makes a finished chapter inspectable: it stands until you ask for the next one.
 */
export function runChapter(ctx: Ctx, probes: ProbeRegistry, index: number, opts: RunChapterOptions = {}): void {
  const chapter = CHAPTERS[index];
  if (!chapter) {
    ctx.say(`§7all ${CHAPTERS.length} chapter(s) done. \`/scriptevent bedshock:chapter down\` to clear the site.§r`);
    return;
  }
  setIndex(index);

  const problems = validate(chapter.blueprint);
  if (problems.length) {
    // A blueprint that does not survive its own checks must never be placed: a facility built
    // from a bad plan measures the plan.
    ctx.say(`§cchapter "${chapter.name}" has an invalid blueprint and was not built:§r`);
    for (const p of problems) ctx.say(`  §c${p}§r`);
    return;
  }

  whenSiteIsLive((live) => {
    const plot = site();
    if (!live) {
      ctx.say(
        `§cthe site at ${SITE.x}, ${SITE.y}, ${SITE.z} never loaded.§r Nothing was built — and ` +
          `nothing below this is about Bedrock.`,
      );
      return;
    }

    // Everything standing from before comes down first, so this chapter builds into air and
    // cannot inherit a wall somebody else put up.
    for (const previous of CHAPTERS) plot.demolish(previous.blueprint);

    ctx.say(`§l§bchapter ${index + 1}/${CHAPTERS.length} — ${chapter.name}§r`);
    ctx.say(`§7${chapter.about}§r`);

    const built = plot.build(chapter.blueprint);
    if (!built.built) {
      ctx.say(
        `§cbuild stopped at step ${built.done.length + 1}/${chapter.blueprint.steps.length}, ` +
          `"${built.failed}": ${built.why}§r`,
      );
      ctx.say(
        `§7The last complete course is "${built.done[built.done.length - 1] ?? 'nothing'}". It is ` +
          `still standing at ${SITE.x}, ${SITE.y}, ${SITE.z} — go and look.§r`,
      );
      return;
    }
    ctx.say(`§a built:§r ${built.done.join(' → ')}`);

    if (chapter.viewFrom) plot.bring(chapter.viewFrom, chapter.lookAt);

    for (const name of chapter.probes) {
      const probe = probes[name];
      if (!probe) {
        ctx.say(`§e chapter "${chapter.name}" names probe "${name}", which does not exist§r`);
        continue;
      }
      try {
        probe(ctx);
      } catch (err) {
        ctx.say(`§c ${name} threw: ${String(err).split('\n')[0]}§r`);
      }
    }

    whenSettled((settled) => {
      if (!settled) {
        ctx.say(`§e still waiting on: ${outstandingProbes().join(', ')} — their rows are ABSENT§r`);
      }
      if (opts.sweep) {
        runChapter(ctx, probes, index + 1, opts);
        return;
      }
      ctx.say(
        `§l§achapter "${chapter.name}" done.§r §7It is still standing at ${SITE.x}, ${SITE.y}, ` +
          `${SITE.z} — walk it before moving on.§r`,
      );
      ctx.say(
        `§7\`/scriptevent bedshock:chapter next\` to tear it down and build ` +
          `${CHAPTERS[index + 1] ? `"${CHAPTERS[index + 1]!.name}"` : 'nothing (that was the last)'}§r`,
      );
    });
  });
}

/** `/scriptevent bedshock:chapter [next|all|down|<name>]` */
export function dispatch(ctx: Ctx, probes: ProbeRegistry, argument: string, _player: Player): void {
  const what = argument.trim();

  if (what === 'down') {
    whenSiteIsLive((live) => {
      if (!live) {
        ctx.say('§ethe site never loaded, so nothing was cleared.§r');
        return;
      }
      const plot = site();
      for (const chapter of CHAPTERS) plot.demolish(chapter.blueprint);
      setIndex(0);
      ctx.say('§7site cleared, back to the first chapter.§r');
    });
    return;
  }

  if (what === 'all') {
    ctx.say('§7sweeping every chapter without stopping. Nothing will be left standing to look at.§r');
    runChapter(ctx, probes, 0, { sweep: true });
    return;
  }

  if (what === 'next') {
    runChapter(ctx, probes, indexNow() + 1);
    return;
  }

  if (what === '') {
    runChapter(ctx, probes, indexNow());
    return;
  }

  const found = CHAPTERS.findIndex((c) => c.name === what);
  if (found === -1) {
    ctx.say(`§eno chapter called "${what}". They are: ${CHAPTERS.map((c) => c.name).join(', ')}§r`);
    return;
  }
  runChapter(ctx, probes, found);
}
