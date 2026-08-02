/**
 * Where things live, resolved from this file rather than from the working directory.
 *
 * The build-time assertion API is imported by other repositories, so `process.cwd()` during a
 * `bedshock` call is somebody else's project root as often as it is this one.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONTENT_DIR = join(ROOT, 'content');
export const LEDGER_DIR = join(ROOT, 'ledger');
export const LEDGER_FILE = join(LEDGER_DIR, 'observations.jsonl');
export const DOCS_DIR = join(ROOT, 'docs');
export const PACK_DIR = join(ROOT, 'pack');
export const BUILD_DIR = join(ROOT, 'build');
export const DIST_DIR = join(ROOT, 'dist');
