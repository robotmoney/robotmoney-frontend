#!/usr/bin/env bun
// scripts/release/maintenance.ts — the maintenance page for a breaking cutover
// (issue 1484; spec section 8.5; issue 1220's mechanism, reused, not replaced).
//
//   bun scripts/release/maintenance.ts on  --instance <name> [--minutes <n>]   write maintenance.json (state active)
//   bun scripts/release/maintenance.ts off --instance <name>                   remove it
//
// maintenance.json sits at the root of the instance's web directory, which the
// nginx website-server mounts at /srv/web. While the api is unreachable the
// server answers GET /api/status/maintenance from it, so the site reads one
// shape whichever side answered. The off-host fallback page is Cloudflare's
// custom error page, served by itself when the origin is down; it needs no
// step. Run on the target host, in the checkout, by the runner.
//
// THE IMMUTABLE website-server (issue 1628) has no web/ mount. Caddy reads the
// file from its in-memory /srv/maintenance, so when the instance's running
// website-server is a site image (it carries `robotmoney.web.tag`), the file
// is also written there, or removed from there, with `docker exec`. A swap or
// rollback carries an active file into the next container (website-release.ts).
import { join } from "node:path";
import { clearMaintenanceFile, MAINTENANCE_FILE, writeMaintenanceFile, type MaintenanceStatus } from "../lib/maintenance-file.ts";
import { instancePaths, stateRoot } from "../lib/smoke-state.ts";
import { makeDockerRunner, type DockerRunner } from "../lib/smoke-volumes.ts";
import { WEBSITE_IMAGE_LABELS, WEBSITE_MAINTENANCE_DIR } from "../lib/website-image.ts";

/** How long the window is announced for when the step names no length: a breaking cutover is down, migrate, up. */
export const DEFAULT_WINDOW_MINUTES = 30;

/** PURE. The active window `maintenance.json` announces, from `now` for `minutes`. */
export function activeWindow(now: Date, minutes: number = DEFAULT_WINDOW_MINUTES): MaintenanceStatus {
  return {
    state: "active",
    startsAt: now.toISOString(),
    expectedEnd: new Date(now.getTime() + minutes * 60_000).toISOString(),
    message: "Robot Money is being upgraded and is briefly unavailable. Please try again shortly.",
  };
}

/** Switch the page on or off in `webDir`. Returns what happened, in words. */
export function setMaintenance(webDir: string, mode: "on" | "off", now: Date = new Date(), minutes: number = DEFAULT_WINDOW_MINUTES): string {
  if (mode === "on") return `maintenance page on: ${writeMaintenanceFile(webDir, activeWindow(now, minutes))}`;
  return clearMaintenanceFile(webDir) ? `maintenance page off: ${join(webDir, "maintenance.json")} removed` : "maintenance page off: no maintenance.json was present";
}

/** The instance's running website-server when it is an immutable site image, or null (nginx, or none running). */
export function immutableWebsiteServer(docker: DockerRunner, instance: string): string | null {
  const ps = docker(["ps", "-q", "--filter", `label=robotmoney.instance=${instance}`, "--filter", "label=com.docker.compose.service=website-server"]);
  const id = ps.exitCode === 0 ? ps.stdout.trim().split("\n")[0] : "";
  if (!id) return null;
  const tag = docker(["inspect", "--format", `{{index .Config.Labels "${WEBSITE_IMAGE_LABELS.tag}"}}`, id]);
  return tag.exitCode === 0 && tag.stdout.trim() !== "" && tag.stdout.trim() !== "<no value>" ? id : null;
}

/**
 * Switch the page on or off inside the immutable container `id`: its tmpfs is
 * the only place Caddy reads the file from. Throws when the exec fails.
 */
export function setContainerMaintenance(id: string, mode: "on" | "off", now: Date = new Date(), minutes: number = DEFAULT_WINDOW_MINUTES): string {
  const target = `${WEBSITE_MAINTENANCE_DIR}/${MAINTENANCE_FILE}`;
  const argv = mode === "on" ? ["docker", "exec", "-i", id, "sh", "-c", `cat > ${target}`] : ["docker", "exec", id, "rm", "-f", target];
  const r = Bun.spawnSync(argv, { stdin: mode === "on" ? Buffer.from(`${JSON.stringify(activeWindow(now, minutes))}\n`) : "ignore", stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`docker exec into website-server ${id} failed: ${r.stderr.toString().trim()}`);
  return `maintenance page ${mode} in website-server ${id.slice(0, 12)}: ${target} ${mode === "on" ? "written" : "removed"}`;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

if (import.meta.main) {
  const mode = process.argv[2];
  const instance = flag("--instance");
  const minutes = flag("--minutes") === undefined ? DEFAULT_WINDOW_MINUTES : Number(flag("--minutes"));
  if ((mode !== "on" && mode !== "off") || !instance || !Number.isInteger(minutes) || minutes <= 0) {
    console.error("usage: maintenance.ts on|off --instance <name> [--minutes <n>]");
    process.exit(2);
  }
  const paths = instancePaths(stateRoot(process.env), instance, { create: mode === "on" });
  const now = new Date();
  console.log(`[maintenance] ${setMaintenance(paths.webDir, mode, now, minutes)}`);
  const immutable = immutableWebsiteServer(makeDockerRunner(), instance);
  if (immutable !== null) console.log(`[maintenance] ${setContainerMaintenance(immutable, mode, now, minutes)}`);
}
