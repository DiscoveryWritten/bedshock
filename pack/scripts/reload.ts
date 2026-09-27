/**
 * Did the world reload between two halves of a measurement?
 *
 * A probe with two halves and no memory reports the same PASS whether or not the thing between
 * them actually happened. A run made in one sitting is then indistinguishable from the run that
 * answers the question -- a defect in the instrument that produces a confident answer to a
 * question nobody asked.
 *
 * So the first half records SESSION, and the second compares. SESSION is computed at module
 * scope, and script modules are re-evaluated on every world load, so it is new each session by
 * construction: nothing has to remember to change it. Deliberately not a timestamp -- two loads
 * inside the same second would collide, and the case that matters is a quick quit-and-reload.
 *
 * Shared by every probe with a before-and-after-reload shape, so they all mean the same thing by
 * "a reload happened".
 */

export const SESSION = `s${Math.floor(Math.random() * 1e9).toString(36)}`;

/** A token unique to one stamping in this session. */
export const freshToken = (): string => `${SESSION}-${Math.floor(Math.random() * 1e6)}`;

export const reloadedSince = (stampedSession: string): boolean => stampedSession !== SESSION;
