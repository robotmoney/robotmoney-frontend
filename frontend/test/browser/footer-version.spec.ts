// Issue 1713: the footer's release line shows the web tag, the platform
// version, the web commit and its time, read from the real preview server's
// /version.json and a stubbed GET /api/version. Same arrangement as
// api-range-mismatch.spec.ts: the SPA loaded directly, every /api/* answered
// through page.route from the committed goldens.
import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const spaShell = () => readFileSync(join(repoRoot, "frontend/public/index.html"), "utf8");
const GOLDENS = JSON.parse(readFileSync(join(repoRoot, "goldens/api-goldens.json"), "utf8")) as {
  routes: Record<string, unknown>;
};
const LINE = "footer [data-release-identity]";

let server: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  server = spawn("bun", ["scripts/preview-server.ts"], { cwd: repoRoot, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview server did not print its URL within 15s")), 15_000);
    let out = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`preview server exited early (code ${code})`));
    });
  });
});

test.afterAll(() => {
  server?.kill();
});

async function open(page: Page, apiVersionBody: unknown): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route(`${baseUrl}/api/**`, (r: Route) => {
    const path = new URL(r.request().url()).pathname;
    const body = path === "/api/version" ? apiVersionBody : (GOLDENS.routes[path] ?? {});
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route(`${baseUrl}/`, (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: spaShell() }));
  await page.goto(`${baseUrl}/`);
  return errors;
}

async function siteVersion(page: Page): Promise<{ version: string; commit: string; committedAt: string }> {
  return (await page.request.get(`${baseUrl}/version.json`)).json();
}

function utcMinute(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

test("the footer line equals /version.json and the platform version from /api/version", async ({ page }) => {
  const errors = await open(page, { version: "0.9.0", api: "0.5.3", commit: "abcdef12" });
  const v = await siteVersion(page);
  expect(v.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const want = `web-${v.version.replace(/-.*$/, "")} · platform-0.9.0 · ${v.commit.slice(0, 8)} · ${utcMinute(v.committedAt)}`;
  await expect(page.locator(LINE)).toHaveText(want, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("today's {api, commit} response: a dash in the platform slot, never the contract version", async ({ page }) => {
  await open(page, { api: "0.5.3", commit: "abcdef12" });
  const v = await siteVersion(page);
  await expect(page.locator(LINE)).toHaveText(`web-${v.version.replace(/-.*$/, "")} · – · ${v.commit.slice(0, 8)} · ${utcMinute(v.committedAt)}`, { timeout: 15_000 });
  await expect(page.locator(LINE)).not.toContainText("0.5.3");
});
