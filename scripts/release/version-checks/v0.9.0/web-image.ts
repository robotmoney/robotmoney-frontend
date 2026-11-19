// Q40-web-image/C28-web-image (web serving P4 1639, P5 1640, P8 1643, P9 1642): the site is served by
// the immutable signed-bundle container, and a rollback target is kept. Read-only: `docker` on the target
// host, nothing started, stopped or built.
//
// WHAT IT REQUIRES (docs/technical/web-serving-architecture.md §3.2 and §4):
//   - exactly one website-server runs for the instance, and it runs a SITE IMAGE: its labels name a web tag
//     (web-vA.B.C), the bundle commit, the bundle sha256 and the platform commit of its server image (R5).
//     An nginx website-server (no such labels) fails: the first rollout has not happened on this host;
//   - its image is the one `robotmoney-website:<instance>-current` names, so a restart or a platform boot
//     serves it again (P9);
//   - a read-only root filesystem, no bind mount and no volume (R3: the old web/ mount is gone), the
//     scratch paths /config, /data and /srv/maintenance as tmpfs, user 65534:65534, every capability
//     dropped, no-new-privileges (§3.2);
//   - its healthcheck reports healthy;
//   - `docker diff` shows nothing changed at or under the served root /srv/web (R4);
//   - a rollback target: the image `robotmoney-website:<instance>-previous`, or on a host whose first swap
//     came from nginx, the stopped container `<name>-first-rollout` (§4, the first-rollout rule). That is
//     what `bun smoke:web --rollback` starts; the check never runs it.
import { siteImageTag, FIRST_ROLLOUT_SUFFIX } from "../../../lib/website-release.ts";
import { WEBSITE_IMAGE_LABELS, servedRootChanges } from "../../../lib/website-image.ts";
import type { VersionCheck } from "../../version-check.ts";
import { imageIdOf, inspectContainers, websiteContainers, type WebsiteInspect } from "./_web.ts";

/** The tmpfs scratch paths docker-compose.website-image.yml gives the server (§3.2). */
export const SCRATCH_PATHS: readonly string[] = ["/config", "/data", "/srv/maintenance"];

export interface WebImageRead {
  /** The running website-server containers of the instance. */
  readonly running: readonly WebsiteInspect[];
  /** Every website-server container of the instance, stopped ones included. */
  readonly all: readonly WebsiteInspect[];
  /** The image id `-current` names, or null. */
  readonly currentImage: string | null;
  /** The image id `-previous` names, or null. */
  readonly previousImage: string | null;
  /** `docker diff` of the running container, or null when it was not read. */
  readonly diff: string | null;
}

const name = (c: WebsiteInspect): string => c.Name.replace(/^\//, "");

/** PURE. Why the instance is not served by the immutable signed-bundle container with a rollback target; empty when it is. */
export function webImageProblems(r: WebImageRead): string[] {
  if (r.running.length !== 1) return [`${r.running.length} website-server containers run for the instance, not one`];
  const c = r.running[0]!;
  const labels = c.Config.Labels ?? {};
  const out: string[] = [];
  const tag = labels[WEBSITE_IMAGE_LABELS.tag];
  if (!tag) {
    return [
      `website-server ${name(c)} runs ${c.Config.Image ?? c.Image}, which carries no ${WEBSITE_IMAGE_LABELS.tag} label: nginx still serves from the web/ bind mount, so the first rollout of the signed-bundle container has not happened on this host`,
    ];
  }
  if (!/^web-v\d+\.\d+\.\d+$/.test(tag)) out.push(`label ${WEBSITE_IMAGE_LABELS.tag} is ${JSON.stringify(tag)}, not a web-vA.B.C tag`);
  if (!/^[0-9a-f]{7,40}$/.test(labels[WEBSITE_IMAGE_LABELS.commit] ?? "")) out.push(`label ${WEBSITE_IMAGE_LABELS.commit} is ${JSON.stringify(labels[WEBSITE_IMAGE_LABELS.commit] ?? null)}, not a commit`);
  if (!/^[0-9a-f]{64}$/.test(labels[WEBSITE_IMAGE_LABELS.bundleSha256] ?? "")) out.push(`label ${WEBSITE_IMAGE_LABELS.bundleSha256} is ${JSON.stringify(labels[WEBSITE_IMAGE_LABELS.bundleSha256] ?? null)}, not a sha256`);
  if (!/^[0-9a-f]{7,40}$/.test(labels[WEBSITE_IMAGE_LABELS.serverCommit] ?? "")) out.push(`label ${WEBSITE_IMAGE_LABELS.serverCommit} is ${JSON.stringify(labels[WEBSITE_IMAGE_LABELS.serverCommit] ?? null)}, not the server image's platform commit`);
  if (r.currentImage === null) out.push("no image carries the -current tag, so a platform boot would not start this site image again");
  else if (r.currentImage !== c.Image) out.push(`the running image ${c.Image} is not the one -current names (${r.currentImage})`);
  if (c.HostConfig.ReadonlyRootfs !== true) out.push("the root filesystem is writable, not read-only");
  const mounts = (c.Mounts ?? []).filter((m) => m.Type !== "tmpfs");
  if (mounts.length > 0) out.push(`the container mounts ${mounts.map((m) => `${m.Type ?? "?"} ${m.Source ?? "?"} at ${m.Destination ?? "?"}`).join(", ")}; it has no volume and no bind mount`);
  if ((c.HostConfig.Binds ?? []).length > 0) out.push(`the container binds ${(c.HostConfig.Binds ?? []).join(", ")}`);
  const tmpfs = Object.keys(c.HostConfig.Tmpfs ?? {});
  const missingTmpfs = SCRATCH_PATHS.filter((p) => !tmpfs.includes(p));
  if (missingTmpfs.length > 0) out.push(`the scratch paths ${missingTmpfs.join(", ")} are not tmpfs mounts`);
  if (c.Config.User !== "65534:65534") out.push(`the container runs as user ${JSON.stringify(c.Config.User ?? "")}, not 65534:65534`);
  if (!(c.HostConfig.CapDrop ?? []).some((x) => x.toUpperCase() === "ALL")) out.push("not every capability is dropped (CapDrop lacks ALL)");
  if (!(c.HostConfig.SecurityOpt ?? []).some((x) => /^no-new-privileges(:true)?$/.test(x))) out.push("no-new-privileges is not set");
  const health = c.State?.Health?.Status;
  if (health !== "healthy") out.push(`the healthcheck reports ${health ?? "nothing"}, not healthy`);
  if (r.diff === null) out.push("docker diff of the container could not be read");
  else {
    const changed = servedRootChanges(r.diff);
    if (changed.length > 0) out.push(`the served root differs from the image: ${changed.slice(0, 5).join("; ")}`);
  }
  const kept = r.all.find((x) => name(x).endsWith(FIRST_ROLLOUT_SUFFIX) && x.State?.Running !== true);
  if (r.previousImage === null && kept === undefined) out.push("no rollback target: neither a -previous image nor a stopped <name>-first-rollout container, so bun smoke:web --rollback has nothing to start");
  return out;
}

export default (async (ctx) => {
  const ids = websiteContainers(ctx);
  const running = inspectContainers(ctx, ids.running);
  const all = inspectContainers(ctx, ids.all);
  if ("error" in running) return { found: {}, problems: [running.error] };
  if ("error" in all) return { found: {}, problems: [all.error] };
  const currentImage = imageIdOf(ctx, siteImageTag(ctx.instance, "current"));
  const previousImage = imageIdOf(ctx, siteImageTag(ctx.instance, "previous"));
  let diff: string | null = null;
  if (running.length === 1) {
    const d = ctx.docker(["diff", running[0]!.Id]);
    diff = d.code === 0 ? d.stdout : null;
  }
  const serving = running[0];
  return {
    found: {
      project: ctx.project(),
      serving: serving === undefined ? null : { name: name(serving), image: serving.Image, labels: serving.Config.Labels ?? {}, readOnly: serving.HostConfig.ReadonlyRootfs ?? false, mounts: serving.Mounts ?? [], user: serving.Config.User ?? "", health: serving.State?.Health?.Status ?? null },
      currentImage,
      previousImage,
      firstRolloutContainers: all.map(name).filter((n) => n.endsWith(FIRST_ROLLOUT_SUFFIX)),
    },
    problems: webImageProblems({ running, all, currentImage, previousImage, diff }),
  };
}) satisfies VersionCheck;
