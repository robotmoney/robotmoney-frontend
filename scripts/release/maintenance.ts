#!/usr/bin/env bun
// scripts/release/maintenance.ts — the maintenance page for a breaking cutover
// (issue 1484; spec section 8.5; issue 1220's mechanism, reused, not replaced).
//
//   bun scripts/release/maintenance.ts on  --instance <name> [--minutes <n>]   write maintenance.json (state active)
//   bun scripts/release/maintenance.ts off --instance <name>                   remove it
//
// maintenance.json sits at the root of the instance's web directory, which
// website-server mounts at /srv/web. While the api is unreachable nginx answers
// GET /api/status/maintenance from it (website-server/nginx.conf), so the site
// reads one shape whichever side answered. The off-host fallback page is
// Cloudflare's custom error page, served by itself when the origin is down; it
// needs no step. Run on the target host, in the checkout, by the runner.
import { join } from "node:path";
import { clearMaintenanceFile, writeMaintenanceFile, type MaintenanceStatus } from "../lib/maintenance-file.ts";
import { instancePaths, stateRoot } from "../lib/smoke-state.ts";

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
  console.log(`[maintenance] ${setMaintenance(paths.webDir, mode, new Date(), minutes)}`);
}
