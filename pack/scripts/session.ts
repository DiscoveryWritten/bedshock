/**
 * `/scriptevent bedshock:session` — the guided run.
 *
 * WHAT THIS IS FOR, and it is a cost problem rather than a features problem.
 *
 * Roughly half this battery needs eyes, and answering those rows used to mean: find the probe
 * items in a creative menu of fifty deliberately-similar things, remember which of them the
 * question is about, remember what you were supposed to be looking for, stand somewhere the rig
 * is actually readable, and then go and type the answer somewhere else. Reported honestly by the
 * person doing it: *"I am probably spending half of my battery just trying to manipulate this
 * game's UI."* A test that expensive to run is a test that does not get run, and this project is
 * worth nothing if the eyes-only half rots.
 *
 * So the session drives instead of instructing. It teleports you to a prepared spot, locks
 * movement so a rig cannot be walked away from, points the camera at the thing being measured,
 * hands you exactly the items that question needs, and shows the question with its enumerated
 * outcomes as buttons. You look, and you tap.
 *
 * THE FORM IS NOT A NEW IDEA — it is the same data `bedshock amend` prints in a terminal.
 * `look_at` and `outcomes` have been required on every observed capability from the start,
 * because a probe that cannot say what to look for and how to tell two results apart is not
 * readable. That requirement turns out to be a UI specification.
 *
 * HOW THE ANSWERS GET OUT, which is the constraint everything else bends around.
 *
 * They do not, except through the screen. `@minecraft/server-net` states it plainly: it *"can
 * only be used on Bedrock Dedicated Server"*. A client has no HTTP, no socket, no egress. On a
 * device with no terminal beside it there is no channel out of this process at all.
 *
 * So a session ends by printing ONE short code — twenty-odd characters, checksummed, in groups
 * of four — that carries every answer. Read it off the screen, hand it over, `bedshock redeem`
 * turns it back into observations. One string per session rather than one sentence per question,
 * and the checksum is what stops a misread becoming a fabricated measurement.
 */

import { InputPermissionCategory, system, world, type Player, type Vector3 } from '@minecraft/server';
import { ActionFormData } from '@minecraft/server-ui';

import { CATALOG_REVISION, QUESTIONS, SNAPSHOT_VERSION, type SessionQuestion } from './catalog.generated.ts';
import { NAMESPACE } from './generated.ts';
import { encodeAnswers, type Answer } from '../../tools/anscode.ts';
import { firstLine, type Ctx } from './emit.ts';
import * as scenes from './probes/scenes.ts';
import * as container from './probes/container.ts';
import * as dynprops from './probes/dynprops.ts';
import * as menu from './probes/menu.ts';
import * as repair from './probes/repair.ts';

const LAST_CODE = 'bedshock:last_code';

/**
 * Which probe sets the scene for a question.
 *
 * Grouped, because one probe stages several questions at once and re-running its setup between
 * them would hand out four ruler items to answer three questions about one.
 */
const STAGE: Record<string, (ctx: Ctx) => void> = {
  ruler: scenes.ruler,
  glyphs: scenes.glyphs,
  flipbook: scenes.flipbook,
  formicon: scenes.formIcons,
  menu: menu.run,
  repair: repair.run,
  container: container.run,
  dynprops: dynprops.run,
};

/** Where the session stands you. Above a flat world's floor, clear of anything. */
const STAGE_AT: Vector3 = { x: 0.5, y: 5, z: 0.5 };

// ---------------------------------------------------------------------------
// Driving the player
// ---------------------------------------------------------------------------

const LOCKED: InputPermissionCategory[] = [
  InputPermissionCategory.Movement,
  InputPermissionCategory.LateralMovement,
  InputPermissionCategory.Sneak,
];

function setLocked(player: Player, locked: boolean): void {
  for (const category of LOCKED) {
    try {
      player.inputPermissions.setPermissionCategory(category, !locked);
    } catch {
      // Not every category exists on every engine version. A rig that cannot be locked is
      // still readable; one that throws here is not.
    }
  }
}

/**
 * Put the player where the rig is readable, facing it.
 *
 * The camera is pointed rather than merely the player, because *where you are standing* has
 * already cost this project two unreadable sessions — a probe placed at an attachable's anchor
 * renders perfectly and is hidden by your own body. Removing the chance to be in the wrong place
 * removes that whole class of wasted run.
 */
function stage(player: Player, question: SessionQuestion): void {
  try {
    player.teleport(STAGE_AT, { facingLocation: { x: STAGE_AT.x, y: STAGE_AT.y, z: STAGE_AT.z + 4 } });
  } catch {
    /* an unloaded chunk is the probe's problem to report, not the session's */
  }
  setLocked(player, true);

  // Only world-facing questions get the camera taken over. A question about your own hotbar or
  // about a form is answered by looking DOWN or at a screen, and seizing the view for those
  // would fight the player for no gain.
  const worldFacing = question.probe === 'container' || question.probe === 'attachable';
  try {
    if (worldFacing) {
      player.camera.setCamera('minecraft:free', {
        location: { x: STAGE_AT.x, y: STAGE_AT.y + 1.6, z: STAGE_AT.z - 3 },
        facingLocation: { x: STAGE_AT.x, y: STAGE_AT.y + 1, z: STAGE_AT.z + 2 },
      });
    } else {
      player.camera.clear();
    }
  } catch {
    /* the camera API is a convenience here, never the measurement */
  }
}

function release(player: Player): void {
  setLocked(player, false);
  try {
    player.camera.clear();
  } catch {
    /* nothing to restore */
  }
}

/**
 * Show a form, waiting out a player who has something else open.
 *
 * A form refuses while any other UI is up, and the session is triggered by a chat command — so
 * the very first form is shown while the chat window is still closing, every single time. A
 * naive `.show()` would fail the first question of every session.
 */
async function showWhenFree<T extends { canceled?: boolean; cancelationReason?: unknown }>(
  show: () => Promise<T>,
  tries = 40,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const response = await show();
    if (!response.canceled) return response;
    if (String(response.cancelationReason ?? '') !== 'UserBusy') return response;
    await waitTicks(10);
  }
  return undefined;
}

function waitTicks(ticks: number): Promise<void> {
  return new Promise((resolve) => system.runTimeout(() => resolve(), ticks));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function chosen(all: boolean): SessionQuestion[] {
  return QUESTIONS.filter((q) => all || q.askByDefault);
}

async function ask(player: Player, question: SessionQuestion, at: number, of: number): Promise<number | undefined> {
  const form = new ActionFormData()
    .title(`§l${at}/${of}§r ${question.id.split('.').slice(-1)[0]}`)
    .body(
      `§7${question.id}§r\n\n§l${question.question}§r\n\n` +
        (question.look_at ? `§6Look at:§r ${question.look_at}\n` : '') +
        (question.priorStatus === 'CLOSED-NEGATIVE'
          ? `\n§8Measured NO on ${SNAPSHOT_VERSION}. You are being asked again because that is the ` +
            `answer most worth watching for a change.§r`
          : ''),
    );

  for (const outcome of question.outcomes) {
    // The verdict is shown, not hidden. A person choosing between "it rendered" and "I could not
    // tell" should be able to see that one of those is a finding and the other is not.
    form.button(`${outcome.label}\n§8[${outcome.verdict}]§r`);
  }
  form.button('§8skip — did not look§r');

  const response = await showWhenFree(() => form.show(player));
  if (!response || response.canceled || response.selection === undefined) return undefined;
  if (response.selection >= question.outcomes.length) return undefined;
  return response.selection;
}

async function runSession(player: Player, ctx: Ctx, all: boolean): Promise<void> {
  const questions = chosen(all);
  if (questions.length === 0) {
    ctx.say('§aNothing needs your eyes.§r Everything this pack knows about was settled when it was built.');
    ctx.say(`§7Run \`/scriptevent ${NAMESPACE}:session all\` to be asked anyway.§r`);
    return;
  }

  // AN ActionFormData, NOT A MessageFormData, AND THAT IS THE WHOLE FIX.
  //
  // `MessageFormData` has exactly two buttons and returns a `selection` whose mapping to
  // `button1`/`button2` is not what the names suggest. This code guessed it — the comment here
  // used to assert "`selection` 1 is button1" — and guessed WRONG, so tapping **Start** took the
  // same branch as tapping "Not now". The session could not be started at all, by anyone, ever.
  // Reported from a phone: "I pushed to begin, and it didn't do anything else."
  //
  // Every question below already uses `ActionFormData`, where `selection` is the index of the
  // button in the order they were added and there is nothing to get backwards. Using it here too
  // means the intro cannot disagree with the questions about what a tap means.
  const intro = new ActionFormData()
    .title('bedshock — guided run')
    .body(
      `§l${questions.length} question(s)§r need your eyes.\n\n` +
        'You will be moved into place and held there for each one, given whatever items it ' +
        'needs, and shown the question with its answers as buttons.\n\n' +
        '§6Nothing is guessed for you.§r Every question has an "I could not tell" answer, and ' +
        'picking it is a better outcome than a confident wrong one.\n\n' +
        'At the end you get one short code. That code IS the result — read it off the screen ' +
        'and hand it over.',
    )
    .button('Start')
    .button('Not now');

  const start = await showWhenFree(() => intro.show(player));
  // THREE OUTCOMES, AND THEY USED TO PRINT THE SAME SENTENCE. "Nothing recorded." was said when
  // the form never opened, when it was declined, and when the button mapping was wrong — so the
  // one line a person had to go on could not tell a bug from a decision.
  if (!start) {
    ctx.say('§ethe form never opened§r — the client refused it 40 times running. Try again.');
    return;
  }
  if (start.canceled || start.selection !== 0) {
    ctx.say('§7Nothing recorded.§r Run it again when you have a few minutes.');
    return;
  }

  const answers: Answer[] = [];
  let staged = '';

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]!;

    if (question.probe !== staged) {
      stage(player, question);
      const setup = STAGE[question.probe];
      if (setup) {
        try {
          setup(ctx);
        } catch (err) {
          ctx.say(`§ecould not set up ${question.probe}:§r ${firstLine(err)}`);
        }
      }
      staged = question.probe;
      // One tick for the scene to actually exist before a form covers it.
      await waitTicks(10);
    }

    const picked = await ask(player, question, i + 1, questions.length);
    if (picked === undefined) continue;
    answers.push({ capability: question.index, outcome: picked });
  }

  release(player);
  finish(player, ctx, answers);
}

function finish(player: Player, ctx: Ctx, answers: Answer[]): void {
  if (answers.length === 0) {
    ctx.say('§7Nothing answered, so there is no code.§r');
    return;
  }

  let code: string;
  try {
    code = encodeAnswers(CATALOG_REVISION, answers);
  } catch (err) {
    ctx.say(`§ccould not build the answer code:§r ${firstLine(err)}`);
    return;
  }

  world.setDynamicProperty(LAST_CODE, code);
  console.warn(`BEDSHOCK CODE ${code}`);

  const body =
    `§l${answers.length} answer(s).§r\n\n` +
    `§a§l${code}§r\n\n` +
    '§7That string is the whole result. Read it back or screenshot it, and hand it over — ' +
    'it decodes to exactly the answers you gave, and refuses to decode at all if a character ' +
    'is wrong.§r\n\n' +
    `§8Re-show it any time with /scriptevent ${NAMESPACE}:code§r`;

  new ActionFormData().title('bedshock — your answer code').body(body).button('Done')
    .show(player)
    .catch(() => {
      /* the chat copy below is the one that matters */
    });

  ctx.say(`§l--- answer code ---§r`);
  ctx.say(`§a§l${code}§r`);
  ctx.say(`§7${answers.length} answer(s). Hand this over; nothing else needs to leave the game.§r`);
}

// ---------------------------------------------------------------------------

export function start(ctx: Ctx, player: Player, all: boolean): void {
  runSession(player, ctx, all).catch((err: unknown) => {
    release(player);
    console.warn(`BEDSHOCK ERROR session ${firstLine(err)}`);
    ctx.say(`§cthe session stopped:§r ${firstLine(err)}`);
  });
}

/** `/scriptevent bedshock:code` — show the last code again, for a session that got interrupted. */
export function showLastCode(ctx: Ctx): void {
  const code = world.getDynamicProperty(LAST_CODE);
  if (typeof code !== 'string') {
    ctx.say('§7No answer code yet.§r Run the session first.');
    return;
  }
  ctx.say(`§a§l${code}§r`);
  console.warn(`BEDSHOCK CODE ${code}`);
}
