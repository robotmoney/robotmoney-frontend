// Shared reads for v0.9.0's website checks (web serving epic 1623): the instance's website-server on this
// host, through `docker` only. Not a check itself: version-check.ts runs files by check name, and no step
// names this one (a leading underscore is no valid check name).
import type { VersionCheckContext } from "../../version-check.ts";

/** The parts of `docker inspect <container>` the checks read. */
export interface WebsiteInspect {
  readonly Id: string;
  readonly Name: string;
  /** The image id the container runs. */
  readonly Image: string;
  readonly State?: { readonly Running?: boolean; readonly Health?: { readonly Status?: string } | null } | null;
  readonly Config: {
    readonly Image?: string;
    readonly User?: string;
    readonly Labels: Readonly<Record<string, string>> | null;
  };
  readonly HostConfig: {
    readonly ReadonlyRootfs?: boolean;
    readonly CapDrop?: readonly string[] | null;
    readonly SecurityOpt?: readonly string[] | null;
    readonly Tmpfs?: Readonly<Record<string, string>> | null;
    readonly Binds?: readonly string[] | null;
  };
  readonly Mounts?: readonly { readonly Type?: string; readonly Source?: string; readonly Destination?: string }[] | null;
}

/** The compose service every website-server container carries. */
export const WEBSITE_SERVICE = "website-server";

/** Lines of a docker command's stdout, trimmed, empty ones dropped. */
export const linesOf = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** The instance's website-server containers: running, and every one with the label (a stopped first-rollout container included). */
export function websiteContainers(ctx: Pick<VersionCheckContext, "docker" | "project">): { running: string[]; all: string[] } {
  const project = ctx.project();
  const filters = ["--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${WEBSITE_SERVICE}`];
  const running = linesOf(ctx.docker(["ps", "--no-trunc", ...filters, "--format", "{{.ID}}"]).stdout);
  const all = linesOf(ctx.docker(["ps", "-a", "--no-trunc", ...filters, "--format", "{{.ID}}"]).stdout);
  return { running, all };
}

/** `docker inspect` of containers, or why it could not be read. */
export function inspectContainers(ctx: Pick<VersionCheckContext, "docker">, ids: readonly string[]): WebsiteInspect[] | { error: string } {
  if (ids.length === 0) return [];
  const r = ctx.docker(["inspect", ...ids]);
  if (r.code !== 0) return { error: `docker inspect failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
  try {
    return JSON.parse(r.stdout) as WebsiteInspect[];
  } catch {
    return { error: "docker inspect printed no JSON" };
  }
}

/** The image id a tag names on this host, or null when no image carries it. */
export function imageIdOf(ctx: Pick<VersionCheckContext, "docker">, ref: string): string | null {
  const r = ctx.docker(["image", "inspect", "--format", "{{.Id}}", ref]);
  const id = r.stdout.trim();
  return r.code === 0 && id !== "" ? id : null;
}

/** The host port a container publishes for a container port, on loopback; null when it publishes none. */
export function loopbackPort(ctx: Pick<VersionCheckContext, "docker">, container: string, port: number): number | null {
  const r = ctx.docker(["port", container, `${port}/tcp`]);
  if (r.code !== 0) return null;
  for (const l of linesOf(r.stdout)) {
    const m = /:(\d+)$/.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}
