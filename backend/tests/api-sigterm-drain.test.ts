// Issue 1378: the api exits 0 on SIGTERM inside its grace bound, and a request
// already in flight when the signal lands is answered 200, not cut.
//
// Before the fix the api registered no SIGTERM handler, so `docker stop` was
// ignored and the container was SIGKILLed after Docker's grace (exit 137),
// cutting whatever request was running. This boots the real entrypoint
// (`bun run src/api/index.ts`) as rm_app on this file's migrated database, as
// tests/support/automation-auth.ts bootApi does.
//
// THE SLOW REQUEST. No production route can be made to take a fixed time, and
// the api must not grow a test-only route. So a `bun --preload` plugin
// (writeRedControlPreload) adds one 1.5 s route to the loaded copy of
// src/api/index.ts in this test only; the drain code under test is unchanged.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { fixtureDb } from "./support/fixture-db.ts";
import { readManifest, writeManifest } from "../src/db/schema-manifest.ts";
import { loadSnapshot } from "../src/db/schema-snapshot.ts";
import { writeRedControlPreload } from "./support/automation-auth.ts";
import { freePort } from "./support/startup-preflight.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const backendDir = join(import.meta.dir, "..");
const SLOW_MS = 1_500;
const GRACE_MS = 10_000;

let proc: ReturnType<typeof Bun.spawn> | null = null;
afterAll(() => { if (proc && proc.exitCode === null) proc.kill("SIGKILL"); });

async function boot(): Promise<{ base: string; proc: ReturnType<typeof Bun.spawn> }> {
  const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if ((await readManifest(fixtureDb)) === null) await writeManifest(fixtureDb, (await loadSnapshot()).manifest);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${db}`;
  url.username = "rm_app";
  url.password = process.env.RM_TEST_ROLE_PASSWORD!;
  const port = await freePort();
  const needle = `if (req.method === "OPTIONS") return corsPreflightResponse(req, pathname);`;
  const preload = writeRedControlPreload(
    "src/api/index.ts",
    needle,
    `if (pathname === "/__test_slow") { await Bun.sleep(${SLOW_MS}); return new Response("slow-ok", { status: 200 }); }\n    ${needle}`,
  );
  const p = Bun.spawn(["bun", "run", "--preload", preload, "src/api/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: url.toString(), API_PORT: String(port), API_SHUTDOWN_GRACE_MS: String(GRACE_MS) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (p.exitCode !== null) throw new Error(`api exited with ${p.exitCode}:\n${await new Response(p.stderr as ReadableStream).text()}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
    await Bun.sleep(100);
  }
  return { base, proc: p };
}

test("SIGTERM: the in-flight request answers 200, new connections are refused, and the api exits 0 inside its grace", async () => {
  const booted = await boot();
  proc = booted.proc;
  const inflight = fetch(`${booted.base}/__test_slow`).then(async (r) => ({ status: r.status, body: await r.text() }));
  await Bun.sleep(300); // the request is now being handled
  const signalledAt = Date.now();
  proc.kill("SIGTERM");
  const answered = await inflight;
  expect(answered).toEqual({ status: 200, body: "slow-ok" });
  const code = await proc.exited;
  const elapsed = Date.now() - signalledAt;
  const out = await new Response(proc.stdout as ReadableStream).text();
  expect(code).toBe(0);
  expect(elapsed).toBeLessThan(GRACE_MS);
  // And no longer than that request: the boot's idle keep-alive connections
  // (its /health polls) are closed, not held for the 10 s idle timeout. A
  // harness that SIGTERMs the api and gives it 5 s (scheduler-api-runtime's
  // afterAll) depends on this.
  expect(elapsed).toBeLessThan(SLOW_MS + 3_000);
  // It waited for the request rather than exiting at once.
  expect(elapsed).toBeGreaterThanOrEqual(SLOW_MS - 400);
  expect(out).toContain("api SIGTERM received: draining");
  expect(out).toContain("exiting 0");
  await expect(fetch(`${booted.base}/health`)).rejects.toThrow();
}, 90_000);
