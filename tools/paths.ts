/**
 * Where things live.
 *
 * Resolved from this file rather than from the working directory, because the build-time
 * assertion API is imported by other repositories and `process.cwd()` during a `bedshock` call
 * is somebody else's project root as often as it is this one.
 *
 * EVERY DATA PATH IS OVERRIDABLE, and that is the point rather than a convenience. bedshock is
 * meant to be vendored — a submodule at `vendor/bedshock`, a local action at
 * `uses: ./vendor/bedshock` — and a repository that vendors it may want to keep its OWN
 * capability catalog and its OWN ledger while borrowing the apparatus. A pack with questions
 * nobody else cares about is a perfectly good reason to run this, and a project measuring its
 * own answers rather than inheriting ours is a *better* proof than citing ours.
 *
 * So: point `BEDSHOCK_CATALOG` and `BEDSHOCK_LEDGER` at your own files and everything else
 * follows. The code that reads them is the product; the questions and answers in this
 * repository are one instance of it.
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** An override is relative to the CALLER's directory, which is what a vendoring repo means. */
function fromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export const PACK_DIR = join(ROOT, 'pack');
export const BUILD_DIR = fromEnv('BEDSHOCK_BUILD', join(ROOT, 'build'));
export const DIST_DIR = fromEnv('BEDSHOCK_DIST', join(ROOT, 'dist'));

/** The questions. Override to run this apparatus against a catalog of your own. */
export const CONTENT_DIR = fromEnv('BEDSHOCK_CONTENT', join(ROOT, 'content'));
export const CATALOG_DIR = fromEnv('BEDSHOCK_CATALOG', join(CONTENT_DIR, 'capabilities'));

/** The answers. Override to keep your own ledger rather than appending to this one. */
export const LEDGER_FILE = fromEnv('BEDSHOCK_LEDGER', join(ROOT, 'ledger', 'observations.jsonl'));
export const LEDGER_DIR = dirname(LEDGER_FILE);

/** Where generated documents go. */
export const DOCS_DIR = fromEnv('BEDSHOCK_DOCS', join(ROOT, 'docs'));

/** True when any data path has been redirected — the report says so, so a reader knows. */
export function isVendored(): boolean {
  return Boolean(process.env.BEDSHOCK_CATALOG || process.env.BEDSHOCK_LEDGER || process.env.BEDSHOCK_CONTENT);
}
