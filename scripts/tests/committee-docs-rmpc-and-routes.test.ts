// Committee docs consistency guard (issue #190), pattern from
// scripts/tests/projects-source-docs.test.ts. Two checks:
//
//   1. participation.html's "Generate your ed25519 identity" section
//      (#generate-identity) must promote the rmpc CLI (robotmoney-core) —
//      the issue's own AC1.
//   2. Every /api/committee/... path literal documented in participation.html
//      and api-reference.html must still appear (structurally, allowing for
//      :param vs <param> placeholder spelling) in contract/src/routes.js's
//      committee route table — the issue's own AC3, re-run against the
//      edited files so the docs can never silently drift from the real route
//      contract.
//
// Runs in the required integration.yml root job via `bun test scripts/tests`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";

const repoRoot = join(import.meta.dir, "../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const PARTICIPATION = "frontend/public/views/docs/investment-committee/participation.html";
const API_REFERENCE = "frontend/public/views/docs/investment-committee/api-reference.html";

function decodeEntities(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Pull the '#generate-identity' section: from its <h2> to the next <h2>.
function extractSection(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) throw new Error(`section id="${id}" not found`);
  const nextH2 = html.indexOf("<h2", html.indexOf(">", start) + 1);
  return html.slice(start, nextH2 === -1 ? undefined : nextH2);
}

// Extract every /api/committee/... path literal a doc reader would copy,
// including placeholder segments spelled either ":id" or "<id>" (both appear
// across participation.html and api-reference.html). Stops a segment at a
// real closing HTML tag (e.g. "</code>", which has NO angle-bracket
// placeholder form since placeholders never start with "/").
const PATH_RE = /\/api\/committee(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_]+|<[A-Za-z0-9_]+>))+/g;

function extractDocPaths(html: string): string[] {
  const decoded = decodeEntities(html);
  const matches = decoded.match(PATH_RE) ?? [];
  // Drop the one literal ellipsis reference ("/api/committee/...") — not a
  // real endpoint, just prose shorthand for "the committee namespace".
  return matches.filter((m) => !m.endsWith("/..."));
}

// Normalize a path template's placeholder segments (":id", "<id>") to a
// single wildcard token so spelling differences between the docs and the
// contract don't produce false positives — only path SHAPE is asserted.
function normalize(p: string): string {
  return p
    .split("/")
    .map((seg) => (seg.startsWith(":") || (seg.startsWith("<") && seg.endsWith(">")) ? "*" : seg))
    .join("/");
}

function flattenRoutes(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) flattenRoutes(v, out);
  return out;
}

describe("participation.html promotes rmpc as the recommended signing tool", () => {
  test("#generate-identity references rmpc and robotmoney-core", () => {
    const section = extractSection(read(PARTICIPATION), "generate-identity");
    expect(section).toContain("rmpc");
    expect(section).toContain("robotmoney-core");
  });
});

describe("participation.html links the runnable starter committee agent", () => {
  test("wiring quickstart names the repo-native starter", () => {
    const section = extractSection(read(PARTICIPATION), "starter-agent-quickstart");
    expect(section).toContain("scripts/starter-committee-agent.ts");
    expect(section).toContain("--transport=rest");
    expect(section).toContain("--transport=mcp");
    expect(section).toContain("client_credentials");
  });
});

describe("documented /api/committee/... paths match contract/src/routes.js", () => {
  const contractPaths = flattenRoutes(ROUTES).filter((p) => p.startsWith("/api/committee"));
  const normalizedContract = new Set(contractPaths.map(normalize));

  // Canary against a vacuous pass — the contract is known to define committee
  // routes today.
  test("contract defines a non-empty committee route table", () => {
    expect(contractPaths.length).toBeGreaterThan(0);
  });

  for (const [label, rel] of [
    ["participation.html", PARTICIPATION],
    ["api-reference.html", API_REFERENCE],
  ] as const) {
    test(`every /api/committee path documented in ${label} matches a contract route`, () => {
      const docPaths = extractDocPaths(read(rel));
      // Canary: each doc is known to reference committee endpoints today.
      expect(docPaths.length).toBeGreaterThan(0);

      const missing = [...new Set(docPaths)]
        .map((p) => ({ path: p, normalized: normalize(p) }))
        .filter(({ normalized }) => !normalizedContract.has(normalized));
      expect(
        missing,
        `${rel} documents /api/committee paths absent from contract ROUTES:\n` +
          missing.map((m) => `  ${m.path} (normalized: ${m.normalized})`).join("\n"),
      ).toEqual([]);
    });
  }
});
