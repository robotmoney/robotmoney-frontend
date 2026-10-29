// Q39-vintage-build-identity/C27-vintage-build-identity (PR 1445): a vintage's build identity is the image's
// git commit, the same value `/api/version` reports. The check reads the commit
// the running api reports, then the vintages of the newest published run
// (`/vintages?run_key=`), and requires every one to carry that commit. A vintage
// from before the change carries `pkg:...`; a run that finished before the boot
// carries the old commit. Either fails, naming which: the check needs a run
// since the boot, and never skips for want of one.
// Reads only: GETs of /api/version and the public routes.
import { getWithRetry, PUBLIC_API, realNet, type Net } from "../../public-analytics-read.ts";
import { parseRunningVersion } from "../../ledger.ts";
import { latestRun } from "../../sdk-lib.ts";
import type { VersionCheck } from "../../version-check.ts";

/** PURE. Why the vintages' build identity is not the running commit; empty when it is. */
export function buildIdentityProblems(apiCommit: string | null, vintages: readonly { id: string | number; build_identity: unknown }[]): string[] {
  const out: string[] = [];
  if (apiCommit === null) out.push("/api/version reports no commit to compare with");
  if (vintages.length === 0) out.push("the newest run has no vintage");
  for (const v of vintages) {
    const id = v.build_identity;
    if (apiCommit === null) break;
    if (id === apiCommit) continue;
    const why = typeof id === "string" && id.startsWith("pkg:") ? "a package-version identity, the shape before PR 1445"
      : typeof id === "string" && id.startsWith("unavailable") ? "an unavailable identity: the image bakes no commit"
      : "another commit: the run was built before this boot, so wait for a run since the boot";
    out.push(`vintage ${v.id}: build identity is ${JSON.stringify(id)} (${why}), /api/version reports ${apiCommit}`);
  }
  return out;
}

export async function vintageIdentity(net: Net): Promise<{ found: Record<string, unknown>; problems: string[] }> {
  const ver = await getWithRetry(net, "/api/version");
  const running = parseRunningVersion(ver.status === 200 ? await ver.text() : null);
  const apiCommit = "error" in running ? null : running.commit;
  const latest = await latestRun(net, "the vintage build identity check");
  if ("problem" in latest) return { found: { apiCommit }, problems: [latest.problem] };
  const res = await getWithRetry(net, `${PUBLIC_API}/vintages?run_key=${encodeURIComponent(latest.run.run_key)}&limit=100`);
  if (res.status !== 200) return { found: { apiCommit, run_key: latest.run.run_key }, problems: [`GET ${PUBLIC_API}/vintages?run_key=${latest.run.run_key} answered ${res.status}`] };
  const vintages = ((await res.json()) as { vintages?: { id: string | number; build_identity: unknown }[] }).vintages ?? [];
  return {
    found: { apiCommit, run_key: latest.run.run_key, vintages: vintages.map((v) => ({ id: v.id, build_identity: v.build_identity })) },
    problems: [...("error" in running ? [running.error] : []), ...buildIdentityProblems(apiCommit, vintages)],
  };
}

export default ((ctx) => vintageIdentity(realNet(ctx.origin))) satisfies VersionCheck;
