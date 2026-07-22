// Contract-coverage guard (maintainability finding 019 / issue #129).
// contract/src/routes.js is documented as the single source of truth for HTTP
// endpoint paths, but nothing used to fail when a backend handler registered a
// new /api/ path as a raw string literal outside the contract. This test closes
// that hole hermetically (no DB, no server): it scans every TypeScript source
// under backend/src/api/ — the only place routes are registered — extracts each
// quoted "/api/..." string literal, and asserts it is covered by the flattened
// contract ROUTES:
//
//   • a literal ENDING IN "/" is a dispatch/startsWith prefix (e.g.
//     "/api/committee/", "/api/admin/jobs/") and must be a prefix of at least
//     one contract route template;
//   • any other literal is a full endpoint path and must appear VERBATIM among
//     the contract route templates.
//
// Handlers that build their match from ROUTES (the committee router compiles
// the contract templates into its regexes) are covered by construction —
// templates with :params never appear as literals here. Registering a new
// /api/ path as a hardcoded string without adding it to contract ROUTES makes
// this test fail with the offending file + literal.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";

const API_SRC = join(import.meta.dir, "..", "src", "api");

function flattenRoutes(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) flattenRoutes(v, out);
  return out;
}

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Quoted or backticked string literals that START with /api/ (an interpolated
// `${BASE}/api/...` template cannot occur server-side; handlers compare
// url.pathname). Regex literals are not quoted and are ROUTES-built anyway.
const API_LITERAL_RE = /["'`](\/api\/[^"'`\s$]*)["'`]/g;

test("every /api/ path registered in backend/src/api appears in contract ROUTES", () => {
  const routes = flattenRoutes(ROUTES);
  expect(routes.length).toBeGreaterThan(0);

  const found: { file: string; literal: string }[] = [];
  for (const file of tsFiles(API_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(API_LITERAL_RE)) {
      found.push({ file: file.slice(API_SRC.length + 1), literal: m[1] });
    }
  }
  // Canary against a vacuous pass: the api sources are KNOWN to carry /api/
  // literals today (the index.ts dispatch prefixes + admin routes). If this
  // ever hits zero, the extraction regex has rotted — fail loudly rather than
  // silently asserting nothing.
  expect(found.length).toBeGreaterThan(0);

  const violations = found.filter(({ literal }) =>
    literal.endsWith("/")
      ? !routes.some((r) => r.startsWith(literal)) && literal !== "/api/" // dispatch prefix must lead into a contract route
      : !routes.includes(literal), // full endpoint must be a contract route template
  );
  expect(
    violations,
    `backend/src/api registers /api/ paths missing from contract ROUTES (add them to contract/src/routes.js):\n` +
      violations.map((v) => `  ${v.file}: "${v.literal}"`).join("\n"),
  ).toEqual([]);
});

// The generic /api/ 404 fallback prefix is fine by definition. Contract routes
// otherwise stay API-only except for explicitly rendered client permalinks;
// keeping the latter in a narrow allowlist prevents an accidental non-API
// string from weakening the backend comparison above.
test("every contract ROUTES template is API-owned or an explicit rendered permalink", () => {
  const renderedPermalinks = new Set([ROUTES.committee.takePermalink]);
  for (const r of flattenRoutes(ROUTES)) {
    expect(
      r === "/health" || r.startsWith("/api/") || renderedPermalinks.has(r),
      `unexpected contract route shape: ${r}`,
    ).toBe(true);
  }
});
