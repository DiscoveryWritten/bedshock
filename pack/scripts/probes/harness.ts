/**
 * Can a pack run code it was handed at runtime?
 *
 * The question the thin client rests on. If yes, the tests live on the test server and the pack
 * only runs what it is sent (rpc.ts). If no, the pack's fixed methods are the whole surface and
 * every new kind of test is a new build.
 */

import { firstLine, result, willReportLater, type Ctx } from '../emit.ts';
import { compile } from '../rpc.ts';

const ROW = 'harness.eval.compiles_received_code';

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
