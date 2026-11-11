#!/usr/bin/env bun
// scripts/release/stage-browser.ts — the web release's headless browser on the
// stage host (D81 amendment, owner 2026-11-11; release-runbooks.md §12).
//
//   bun scripts/release/stage-browser.ts install   install Playwright's Chromium on stage-2, pinned to this repo's Playwright
//   bun scripts/release/stage-browser.ts probe     launch it once with its sandbox on, load nothing
//
// Run from the CONTROL machine. Every browser of a web release runs on the
// stage host, never here: W01's probe, W06's smoke of the stage site and W11's
// smoke of production. The control machine copies ./web-browser-smoke.ts to the
// host as a bundle, runs it there over ssh with stdin closed and `env -i`, and
// reads the reports back as JSON; ./web-release-lib.ts judges them.
//
// `install` writes STAGE_BROWSER.dir (./stage-browser-lib.ts): a package.json
// pinning @playwright/test to the version this checkout's bun.lock resolved,
// its node_modules, Playwright's headless shell under ./browsers, the bundle,
// and the AppArmor profile file the owner installs once as root
// (OWNER_SANDBOX_COMMANDS). It never runs sudo. It is outside the stage
// target's HOME, so `stage-target.ts down` keeps it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPARMOR_PROFILE, OWNER_SANDBOX_COMMANDS, OWNER_SANDBOX_FALLBACK, STAGE_BROWSER as B, stageBrowserProblem } from "./stage-browser-lib.ts";
import { shellQuote } from "./steps.ts";
import type { BrowserSmoke, PageReport } from "./web-browser-smoke.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SSH = ["ssh", "-o", "BatchMode=yes", B.host];

/** The @playwright/test version this checkout resolved (bun.lock), so stage runs the same browser revision CI does. */
export function playwrightVersion(): string {
  const v = (JSON.parse(readFileSync(join(ROOT, "node_modules/@playwright/test/package.json"), "utf8")) as { version?: unknown }).version;
  if (typeof v !== "string") throw new Error("node_modules/@playwright/test has no version: run bun install first");
  return v;
}

/** PURE. A command on the stage host under env -i: its HOME, its Bun first on PATH, the browsers under STAGE_BROWSER.browsers. */
export const hostCommand = (argv: readonly string[]): string =>
  `cd ${shellQuote(B.dir)} && env -i HOME=${shellQuote(B.home)} PATH=${shellQuote(B.path)} LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=${shellQuote(B.browsers)} ${argv.map(shellQuote).join(" ")}`;

async function ssh(remote: string, stdin?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([...SSH, remote], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { status, stdout, stderr };
}

async function must(remote: string, what: string, stdin?: string): Promise<string> {
  const r = await ssh(remote, stdin);
  if (r.status !== 0) throw new Error(`${what} on ${B.host} exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

let uploaded = false;
/** Copy this checkout's web-browser-smoke.ts to the host as one bundle (@playwright/test stays external: the host's own install). */
async function uploadBundle(): Promise<void> {
  if (uploaded) return;
  const built = await Bun.build({ entrypoints: [join(ROOT, "scripts/release/web-browser-smoke.ts")], target: "bun", external: ["@playwright/test"] });
  if (!built.success || !built.outputs[0]) throw new Error(`could not bundle web-browser-smoke.ts: ${built.logs.join("; ")}`);
  await must(`mkdir -p ${shellQuote(B.dir)} && cat > ${shellQuote(B.bundle)}`, "upload the browser bundle", await built.outputs[0].text());
  uploaded = true;
}

/**
 * The release's browser (Deps.browser): run the smoke on the stage host and
 * read its reports. With no routes it only launches (W01's probe). Throws with
 * the host's own error, which W01 turns into stageBrowserProblem.
 */
export const stageBrowser: BrowserSmoke = async (origin, routes, budgetMs) => {
  await uploadBundle();
  const argv = ["bun", B.bundle, "--json", "--origin", origin, "--budget-seconds", String(Math.max(1, Math.floor(budgetMs / 1000)))];
  for (const r of routes) argv.push("--route", r);
  const r = await ssh(hostCommand(argv));
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim() || `the stage browser exited ${r.status}`);
  const last = r.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(last) as PageReport[];
  } catch {
    throw new Error(`the stage browser printed no JSON report: ${last.slice(0, 200)}`);
  }
};

async function install(): Promise<number> {
  const version = playwrightVersion();
  console.log(`[stage-browser] installing @playwright/test ${version} and its headless shell into ${B.host}:${B.dir}`);
  await must(`mkdir -p ${shellQuote(B.browsers)} && cat > ${shellQuote(`${B.dir}/package.json`)}`, "write package.json",
    `${JSON.stringify({ name: "rm-web-browser", private: true, dependencies: { "@playwright/test": version } }, null, 2)}\n`);
  await must(hostCommand(["bun", "install"]), "bun install");
  await must(hostCommand(["bun", "x", "playwright", "install", "--only-shell", "chromium"]), "playwright install --only-shell chromium");
  await must(`cat > ${shellQuote(B.profileFile)}`, "write the AppArmor profile file", APPARMOR_PROFILE);
  uploaded = false;
  await uploadBundle();
  console.log(`[stage-browser] installed: ${(await must(`ls -d ${shellQuote(B.browsers)}/chromium_headless_shell-*`, "list the browsers")).trim()}`);
  return probe();
}

async function probe(): Promise<number> {
  try {
    await stageBrowser("https://robotmoney.network", [], 30_000);
    console.log(`[stage-browser] the headless browser on ${B.host} starts with Chromium's sandbox on`);
    return 0;
  } catch (e) {
    const m = (e as Error).message;
    console.error(`[stage-browser] REFUSED: ${stageBrowserProblem(m)}`);
    if (/sandbox/i.test(m)) {
      console.error("[stage-browser] the owner's one-time root step on the stage host:");
      for (const c of OWNER_SANDBOX_COMMANDS) console.error(`  ${c}`);
      console.error(`[stage-browser] host-wide fallback (stage only): ${OWNER_SANDBOX_FALLBACK}`);
      console.error(`[stage-browser] Playwright said: ${m.split("\n").filter((l) => /sandbox/i.test(l)).slice(0, 2).join(" | ")}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    process.exitCode = cmd === "install" ? await install() : cmd === "probe" ? await probe() : (console.error("usage: bun scripts/release/stage-browser.ts install | probe"), 2);
  } catch (e) {
    console.error(`[stage-browser] FAILED: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
