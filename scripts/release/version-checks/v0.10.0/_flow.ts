// Shared reads for v0.10.0's checks that look at the api container: its id and its environment. Not a check itself.
import type { VersionCheckContext } from "../../version-check.ts";

/** PURE. The `KEY=value` lines of `docker inspect` Config.Env as a map. */
export function envMap(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf("=");
    if (i > 0) out.set(l.slice(0, i), l.slice(i + 1));
  }
  return out;
}

/** The running api container's environment, or null when there is not exactly one api container. */
export function apiEnv(ctx: Pick<VersionCheckContext, "docker" | "project">): Map<string, string> | null {
  const ids = ctx.docker(["ps", "--no-trunc", "--filter", `label=com.docker.compose.project=${ctx.project()}`, "--filter", "label=com.docker.compose.service=api", "--format", "{{.ID}}"]).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (ids.length !== 1) return null;
  const r = ctx.docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", ids[0]!]);
  return r.code === 0 ? envMap(r.stdout.split("\n")) : null;
}
