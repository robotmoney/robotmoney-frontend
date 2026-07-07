// Placeholder for the Demo readiness gate phase (issue #63, dev-scout). Reserves
// the CI seam for scripts/demo-frontend-check.ts's dedicated test file so #58 can
// land its negative/broken-marker assertion without also owning file creation.
//
// scripts/demo-frontend-check.ts (see that file) only ever runs against a live
// backend (docker-compose demo stack or `bun run demo`), which this "root" test
// job (`bun run test`, wired in .github/workflows/integration.yml) does not have.
// So this placeholder stands up a minimal in-process static file + API stub
// server that serves the REAL, unmodified frontend/public content plus a stub
// /api/committee/sessions response, then spawns the real script against it and
// asserts a clean exit. #58 extends this file with the stripped-marker negative
// case; it does not need to touch this harness.
import { describe, expect, test } from "bun:test";
import { join, normalize } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const publicDir = join(repoRoot, "frontend", "public");

function startStubBackend() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/committee/sessions") {
        return Response.json({ sessions: [] });
      }
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const safe = normalize(decodeURIComponent(rel)).replace(/^(\.\.(\/|\\|$))+/, "");
      const file = Bun.file(join(publicDir, safe));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
  });
}

describe("scripts/demo-frontend-check.ts (placeholder)", () => {
  test("exits 0 against the real, unmodified view content", async () => {
    const backend = startStubBackend();
    try {
      // MUST be the async Bun.spawn, not spawnSync: the child calls back into
      // this same process's Bun.serve stub over HTTP, and spawnSync blocks the
      // JS event loop that stub needs to answer those requests — a same-thread
      // deadlock that only resolves via the bun:test timeout.
      const proc = Bun.spawn(
        ["bun", "run", "scripts/demo-frontend-check.ts"],
        {
          cwd: repoRoot,
          env: { ...process.env, BACKEND_URL: `http://localhost:${backend.port}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        console.error(await new Response(proc.stdout).text());
        console.error(await new Response(proc.stderr).text());
      }
      expect(exitCode).toBe(0);
    } finally {
      backend.stop(true);
    }
  }, 20_000);
});
