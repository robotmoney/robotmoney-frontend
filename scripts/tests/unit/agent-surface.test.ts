// Guards on the machine-readable surface: llms.txt, openapi.json, the shell's
// discovery links, and the per-route pointers scripts/prerender.ts bakes in.
//
// The failure this exists to prevent is not a crash, it is a quiet regression to
// the status quo it replaces. Every one of these artefacts is invisible in a
// browser: nobody loading robotmoney.network will ever notice that openapi.json
// went stale, that a new public endpoint never reached llms.txt, or that the
// prerender stopped injecting the <noscript> block. The only way any of it stays
// true is for something to assert it on every PR.
//
// It lives in scripts/tests/unit because unit.yml carries no paths filter and so
// runs on every PR regardless of which side was touched. The catalogue reads
// ROUTES from contract/, the generator writes into frontend/public/, and the
// prerender lives in scripts/, so a guard gated on any one of those three would be
// skipped by exactly the change that breaks it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORIGIN,
  PUBLIC_ENDPOINTS,
  assertCatalogCoversRoutes,
  assertCatalogPathsExist,
  endpointsForRoute,
  openApiPath,
} from "../../lib/agent-endpoints.ts";

const repoRoot = join(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

describe("endpoint catalogue", () => {
  test("covers every public route in ROUTES", () => {
    // The anti-drift mechanism. Adding a public GET to ROUTES without either
    // cataloguing it or excluding it with a reason fails here, so the published
    // description cannot fall behind the API it describes.
    expect(assertCatalogCoversRoutes()).toEqual([]);
  });

  test("names no route that ROUTES has since renamed", () => {
    expect(assertCatalogPathsExist()).toEqual([]);
  });

  test("operation ids are unique", () => {
    const ids = PUBLIC_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every endpoint carries a summary, a description and a contract type", () => {
    for (const e of PUBLIC_ENDPOINTS) {
      expect(e.summary.length, `${e.id} summary`).toBeGreaterThan(10);
      expect(e.description.length, `${e.id} description`).toBeGreaterThan(40);
      expect(e.contractType.length, `${e.id} contractType`).toBeGreaterThan(0);
    }
  });

  test("every path parameter in the route template is documented", () => {
    // An undocumented :param leaves a caller holding a URL it cannot fill in.
    for (const e of PUBLIC_ENDPOINTS) {
      const declared = new Set((e.params ?? []).filter((p) => p.in === "path").map((p) => p.name));
      const inTemplate = Array.from(e.path.matchAll(/:([a-zA-Z_]+)/g), (m) => m[1]!);
      for (const name of inTemplate) expect(declared.has(name), `${e.id} path param ${name}`).toBe(true);
      expect(declared.size, `${e.id} declares params the path does not have`).toBe(inTemplate.length);
    }
  });

  test("every page a route claims to back is a real site route", () => {
    // `backs` drives the per-route links; a typo there silently produces a page
    // with no data pointers rather than an error.
    const sitemap = read("frontend/public/sitemap.xml");
    const routes = new Set(Array.from(sitemap.matchAll(/<loc>https:\/\/robotmoney\.network([^<]*)<\/loc>/g), (m) => m[1] || "/"));
    for (const e of PUBLIC_ENDPOINTS) {
      for (const page of e.backs) expect(routes.has(page), `${e.id} backs ${page}, which is not in sitemap.xml`).toBe(true);
    }
  });
});

describe("generated artefacts", () => {
  test("openapi.json and llms.txt are up to date with the catalogue", () => {
    const r = Bun.spawnSync(["bun", "scripts/build-agent-surface.ts", "--check"], { cwd: repoRoot });
    const output = new TextDecoder().decode(r.stderr) + new TextDecoder().decode(r.stdout);
    expect(output).not.toContain("Out of date");
    expect(r.exitCode).toBe(0);
  });

  test("openapi.json is a well-formed 3.1 document over an absolute origin", () => {
    const doc = JSON.parse(read("frontend/public/openapi.json"));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe(ORIGIN);

    const seen = new Set<string>();
    for (const [path, item] of Object.entries<Record<string, any>>(doc.paths)) {
      expect(path.startsWith("/"), `${path} is not rooted`).toBe(true);
      expect(path).not.toContain(":");
      for (const op of Object.values(item)) {
        expect(op.operationId, `${path} operationId`).toBeTruthy();
        expect(seen.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false);
        seen.add(op.operationId);
        expect(op.summary).toBeTruthy();
        expect(op.responses["200"]).toBeTruthy();
      }
    }
    expect(seen.size).toBe(PUBLIC_ENDPOINTS.length);
  });

  test("llms.txt carries every catalogued endpoint as an absolute URL", () => {
    const llms = read("frontend/public/llms.txt");
    for (const e of PUBLIC_ENDPOINTS) {
      if (e.path === "/health") continue;
      expect(llms, `llms.txt is missing ${e.id}`).toContain(ORIGIN + openApiPath(e.path));
    }
  });

  test("llms.txt says plainly that fetching a page will not return the data", () => {
    // The single most load-bearing sentence in the file. An agent that skims
    // llms.txt and still tries to scrape /allocation has learned nothing.
    const llms = read("frontend/public/llms.txt").toLowerCase();
    expect(llms).toContain("single-page app");
    expect(llms).toContain("openapi.json");
    expect(llms).toContain("/health");
  });

  test("no artefact points at the retired robotmoney.net origin", () => {
    // .net is a re-registered ex-Ponzi domain the project inherited flags from;
    // .network is canonical. A stray absolute URL here would hand agents the
    // wrong host as a citation.
    for (const f of ["frontend/public/llms.txt", "frontend/public/openapi.json", "frontend/public/robots.txt"]) {
      const stray = read(f).match(/https:\/\/[a-z0-9.-]*robotmoney\.net(?!work)/g);
      expect(stray, `${f} points at robotmoney.net`).toBeNull();
    }
  });
});

describe("shell discovery links", () => {
  const shell = read("frontend/public/index.html");

  test("the shell advertises openapi.json and llms.txt on every route", () => {
    expect(shell).toContain(`<link rel="service-desc" type="application/json" href="${ORIGIN}/openapi.json"`);
    expect(shell).toContain(`<link rel="alternate" type="text/plain" href="${ORIGIN}/llms.txt"`);
  });

  test("the shell carries the marker the prerender fills", () => {
    expect(shell).toContain("<!--AGENT-DATA-->");
  });

  test("the docs view mount appears exactly once", () => {
    // backend/src/api/static.ts inlines docs fragments by replacing the FIRST
    // occurrence of this exact string. A second copy anywhere above the mount,
    // including inside a comment, would redirect that replacement and silently
    // stop docs pages server-rendering, which is the one part of this site that
    // already reads correctly without JS.
    expect(shell.split('<main id="view"></main>').length - 1).toBe(1);
  });
});

describe("prerendered routes", () => {
  // Run the real prerender over a copy of frontend/public rather than asserting
  // against a committed fixture: the assertion is about what a deploy serves,
  // and a fixture would keep passing after the injection stopped happening.
  const dir = mkdtempSync(join(tmpdir(), "rm-agent-surface-"));
  cpSync(join(repoRoot, "frontend/public"), dir, { recursive: true });
  const result = Bun.spawnSync(["bun", "scripts/prerender.ts"], { cwd: repoRoot, env: { ...process.env, PRERENDER_DIR: dir } });

  test("prerender succeeds", () => {
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("a data route names its endpoints in <head> and in <noscript>", () => {
    const html = readFileSync(join(dir, "allocation/index.html"), "utf8");
    const expected = endpointsForRoute("/allocation");
    expect(expected.length).toBeGreaterThan(0);
    for (const e of expected) {
      const url = ORIGIN + openApiPath(e.path);
      expect(html, `head link for ${e.id}`).toContain(`<link rel="alternate" type="application/json" href="${url}"`);
      expect(html, `noscript entry for ${e.id}`).toContain(`>${url}</a>`);
    }
    expect(html).toContain("<noscript>");
    expect(html).toContain('<section id="agent-data">');
  });

  test("the noscript block is closed and sits outside the view mount", () => {
    // Inside the mount it would be wiped by static.ts's docs inlining and by the
    // client router; outside it, both keep working.
    const html = readFileSync(join(dir, "allocation/index.html"), "utf8");
    expect(html.indexOf("<noscript>")).toBeGreaterThan(html.indexOf('<main id="view"></main>'));
    expect(html.split("<noscript>").length - 1).toBe(html.split("</noscript>").length - 1);
  });

  test("a route with no live data still points at the API index", () => {
    const html = readFileSync(join(dir, "faq/index.html"), "utf8");
    expect(html).toContain(`${ORIGIN}/openapi.json`);
    expect(html).toContain(`${ORIGIN}/llms.txt`);
  });

  test("every prerendered route keeps exactly one docs view mount", () => {
    const html = readFileSync(join(dir, "docs/skill/index.html"), "utf8");
    expect(html.split('<main id="view"></main>').length - 1).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
