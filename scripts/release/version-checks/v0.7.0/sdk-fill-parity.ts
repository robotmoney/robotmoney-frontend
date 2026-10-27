// Q43-sdk-fill-parity/C31-sdk-fill-parity (SDK 0.2.0, PR 1465): the README quickstart's `fill` into a
// fresh folder, and a fill that starts from the first recorded backup (the
// stand-in for a clone of robotmoney/csv-backups), give the same local copy:
// the same files with the same bytes. The SDK is the release commit's, from a
// sparse clone, and the API is the target's. Runs on the control machine; only
// GETs reach the target.
import { realNet } from "../../public-analytics-read.ts";
import { fillParityCheck, realSdkDeps } from "../../sdk-lib.ts";
import type { VersionCheck } from "../../version-check.ts";

export default (async (ctx) => {
  if (!ctx.commit) return { found: {}, problems: ["the step passes no --commit: the SDK is taken from the release commit"] };
  return fillParityCheck(await realSdkDeps(ctx.origin, realNet(ctx.origin)), ctx.commit);
}) satisfies VersionCheck;
