/**
 * Can a pack run code it was handed at runtime?
 *
 * Answered NO on an iPad client (2026-10-01): "TypeError: Function from string is not supported".
 * Kept as a row so the day it changes, something says so. Until then rpc.ts drives the game by
 * reflection over its own API instead of by code.
 */

import { firstLine, result, willReportLater, type Ctx } from '../emit.ts';

const ROW = 'harness.eval.compiles_received_code';

/** Compile `code` as an async function body. Measured, not relied on: see rpc.ts for what is. */
function compile(code: string): () => Promise<unknown> {
  return new Function(`return (async () => {\n${code}\n})();`) as never;
}

export function run(ctx: Ctx): void {
  let f: ReturnType<typeof compile>;
  try {
    f = compile('return 6 * 7');
  } catch (err) {
    result(ctx, ROW, 'NO', { error: firstLine(err) }, `the game refused to compile received code: ${firstLine(err)}`);
    return;
  }
  // The body is async, so the answer arrives a moment later; say so, so the run waits for it.
  const reported = willReportLater('harness');
  f().then(
    (v) => {
      result(ctx, ROW, v === 42 ? 'YES' : 'NO', { returned: v ?? null },
        v === 42 ? 'received code compiled and ran' : 'compiled, but did not return what it should');
      reported();
    },
    (err) => {
      result(ctx, ROW, 'NO', { error: firstLine(err) }, 'compiled, but threw when run');
      reported();
    },
  );
}
