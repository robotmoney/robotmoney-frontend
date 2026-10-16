// Run the web client's browser checks against the preview server — no live
// backend, no Docker. `bun run --cwd frontend check` (fixtures) or
// `... check:prod` / `... check:stage` (the same route sweep, with /api/*
// answered by a live api instead of goldens).
//
//   --api fixtures            goldens answer /api/* (the default; the gate)
//   --api prod|stage|<origin> a live api answers /api/* (advisory; the page
//                             must still load with no console errors, but a
//                             live host being down is not a client defect)
//
//   --api static              the view specs that stub /api/** themselves, served
//                             from the assembled `_static` (run `assemble`
//                             first) by scripts/web-client/static-site-server.ts
//
// Playwright resolves playwright.config.ts from the repo root and the specs
// spawn scripts/preview-server.ts relative to process.cwd(), so this always
// runs from the repo root whatever directory it is invoked from.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { staticSpecs } from "./static-specs.ts";
import { repoRoot } from "./version.ts";

const FIXTURE_SPECS = ["preview-smoke", "api-unreachable", "api-range-mismatch", "preview-routes"];
const LIVE_SPECS = ["preview-routes"];

const args = process.argv.slice(2);
const apiIdx = args.indexOf("--api");
const api = apiIdx === -1 ? "fixtures" : args[apiIdx + 1];
if (!api) {
  console.error("--api needs a value: fixtures | prod | stage | static | <origin>");
  process.exit(2);
}
const passthrough = apiIdx === -1 ? args : [...args.slice(0, apiIdx), ...args.slice(apiIdx + 2)];

if (api === "static") process.exit(await runStatic(passthrough));

const specs = api === "fixtures" ? FIXTURE_SPECS : LIVE_SPECS;
const env = { ...process.env, ...(api === "fixtures" ? {} : { PREVIEW_API: api }) };

console.log(`web-client browser check: api=${api} specs=${specs.join(",")}`);
const proc = Bun.spawn(["bunx", "playwright", "test", ...specs, ...passthrough], {
  cwd: repoRoot,
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);

/** Serve `_static`, point BACKEND_URL at it, and run every spec in staticSpecs(). */
async function runStatic(extra: string[]): Promise<number> {
  if (!existsSync(join(repoRoot, "_static", "index.html"))) {
    console.error("web-client browser check (static): _static is missing — run `bun run --cwd frontend assemble` first");
    return 2;
  }
  const server = Bun.spawn(["bun", "scripts/web-client/static-site-server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("static site server did not print its URL within 15s")), 15_000);
      let out = "";
      void (async () => {
        for await (const chunk of server.stdout) {
          out += new TextDecoder().decode(chunk);
          const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
            return;
          }
        }
        clearTimeout(timer);
        reject(new Error("static site server exited before printing its URL"));
      })();
    });
    const specs = staticSpecs();
    console.log(`web-client browser check: api=static url=${url} specs=${specs.length}`);
    const proc = Bun.spawn(["bunx", "playwright", "test", ...specs, ...extra], {
      cwd: repoRoot,
      env: { ...process.env, BACKEND_URL: url },
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  } finally {
    server.kill();
  }
}
