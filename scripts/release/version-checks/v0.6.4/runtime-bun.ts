// Q35-runtime-bun/C23-runtime-bun: the backend runs on the Bun the release pins.
//
// The change is the runtime under the backend images (backend/Dockerfile's base image) and the
// CI pin. No product row tells the runtimes apart, so the check reads what is deployed: every
// running Bun service of the instance answers `bun --version` with the pinned version. It
// writes nothing.
import type { VersionCheck } from "../../version-check.ts";

export const BUN_VERSION = "1.4.4";
export const BUN_SERVICES = ["api", "worker-analytics", "system-scheduler", "analytics-producer"] as const;

export interface RuntimeObservation {
  /** Per service: the container read, and what `bun --version` printed in it; null when none runs. */
  readonly services: Record<string, { container: string; code: number; version: string } | null>;
}

/** PURE. Every reason the pinned runtime is not the one running. */
export function runtimeBunProblems(o: RuntimeObservation): string[] {
  const out: string[] = [];
  for (const service of BUN_SERVICES) {
    const r = o.services[service];
    if (!r) out.push(`no running ${service} container of the instance to read`);
    else if (r.code !== 0) out.push(`${service} (${r.container}): bun --version exited ${r.code}`);
    else if (r.version !== BUN_VERSION) out.push(`${service} (${r.container}) runs bun ${r.version || "<nothing printed>"}, not ${BUN_VERSION}`);
  }
  return out;
}

export default (async (ctx) => {
  const project = ctx.project();
  const services: Record<string, { container: string; code: number; version: string } | null> = {};
  for (const service of BUN_SERVICES) {
    const container = ctx.docker(["ps", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).find(Boolean);
    if (!container) {
      services[service] = null;
      continue;
    }
    const r = ctx.docker(["exec", container, "bun", "--version"]);
    services[service] = { container, code: r.code, version: r.stdout.trim() };
  }
  return { found: { project, services }, problems: runtimeBunProblems({ services }) };
}) satisfies VersionCheck;
