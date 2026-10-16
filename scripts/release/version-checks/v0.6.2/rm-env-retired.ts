// Q43-rm-env-retired/C29-rm-env-retired (PRs 1325, 1342): RM_ENV and RM_ALLOW_INSECURE are no
// runtime input. 1325 retired both from every container's runtime config and
// removed the insecure knob; 1342 removed RM_ENV from docker-compose.yml, the
// stack composefiles and the participant env, so no container receives it.
// RM_ENV stays an operator's policy input to `bun smoke`, `migrate` and
// `prod-init` on the host (issue 1327): never a container's.
//
// The check reads `Config.Env` of every running container of the instance,
// participants included, and reports only variable NAMES: a container's
// environment holds credentials, and no value is ever read into the receipt.
import type { VersionCheck } from "../../version-check.ts";

export const RETIRED_ENV = Object.freeze(["RM_ENV", "RM_ALLOW_INSECURE"]);

/** PURE. The retired names a container's `Config.Env` carries, set to anything (empty included). */
export function retiredNamesIn(env: readonly string[]): string[] {
  const names = new Set(env.map((line) => (line.includes("=") ? line.slice(0, line.indexOf("=")) : line)));
  return RETIRED_ENV.filter((n) => names.has(n));
}

/** PURE. Every container that still receives a retired name, or why nothing could be read. */
export function retiredEnvProblems(rows: ReadonlyArray<{ container: string; retired: readonly string[] | null }>): string[] {
  if (rows.length === 0) return ["no running container of the instance to read"];
  const out: string[] = [];
  for (const r of rows) {
    if (r.retired === null) out.push(`${r.container}: its environment could not be read`);
    else if (r.retired.length > 0) out.push(`${r.container} still receives ${r.retired.join(", ")}`);
  }
  return out;
}

export default (async (ctx) => {
  const project = ctx.project();
  const names = ctx.docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  const rows = names.map((container) => {
    const r = ctx.docker(["inspect", "-f", "{{json .Config.Env}}", container]);
    let retired: string[] | null = null;
    if (r.code === 0) {
      try { retired = retiredNamesIn(JSON.parse(r.stdout) as string[]); } catch { retired = null; }
    }
    return { container, retired };
  });
  return { found: { project, containers: rows }, problems: retiredEnvProblems(rows) };
}) satisfies VersionCheck;
