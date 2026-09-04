#!/usr/bin/env bun
// Generate the machine-readable half of the site from scripts/lib/agent-endpoints.ts:
//
//   frontend/public/openapi.json   OpenAPI 3.1 description of the public read surface
//   frontend/public/llms.txt       the endpoint block, rewritten between markers
//
// Run `bun run build:agent-surface` after touching the catalogue, and
// `bun run check:agent-surface` in CI. The check mode fails when the generated
// files are out of date OR when ROUTES has grown a public route the catalogue
// does not mention, so the published description cannot silently drift from the
// API it describes.

import { join } from "node:path";
import {
  ORIGIN,
  PUBLIC_ENDPOINTS,
  assertCatalogCoversRoutes,
  assertCatalogPathsExist,
  openApiPath,
  type AgentEndpoint,
} from "./lib/agent-endpoints.ts";

const repoRoot = join(import.meta.dir, "..");
const openApiFile = join(repoRoot, "frontend/public/openapi.json");
const llmsFile = join(repoRoot, "frontend/public/llms.txt");

const BEGIN = "<!-- BEGIN GENERATED ENDPOINTS: bun run build:agent-surface -->";
const END = "<!-- END GENERATED ENDPOINTS -->";

const check = process.argv.includes("--check");

// ── OpenAPI ────────────────────────────────────────────────────────────────
//
// Response bodies are described by NAME rather than by an inlined JSON Schema.
// The types live in @robotmoney/contract as TypeScript declarations, which is
// where they are actually maintained; transcribing them here would create a
// second copy that goes stale the first time a DTO changes. `x-contract-type`
// plus the link to the declaration file is honest about where the truth is and
// still tells a caller what it is holding.
const CONTRACT_SRC = "https://github.com/robotmoney/robotmoney-frontend/tree/main/contract/src";

function operation(e: AgentEndpoint) {
  const params = (e.params ?? []).map((p) => ({
    name: p.name,
    in: p.in,
    required: p.in === "path" ? true : Boolean(p.required),
    description: p.description,
    schema: { type: "string" },
    ...(p.example ? { example: p.example } : {}),
  }));

  const description = [
    e.description,
    e.sizeHint ? `Response size: ${e.sizeHint}.` : null,
    `Response type: \`${e.contractType}\` (see ${CONTRACT_SRC}).`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    operationId: e.id,
    summary: e.summary,
    description,
    ...(e.backs.length ? { tags: ["public-read"], "x-backs-pages": e.backs.map((r) => ORIGIN + r) } : { tags: ["public-read"] }),
    ...(params.length ? { parameters: params } : {}),
    "x-contract-type": e.contractType,
    responses: {
      "200": {
        description: e.summary,
        content: { "application/json": { schema: { type: "object", description: e.contractType } } },
      },
      ...(e.params?.some((p) => p.in === "path")
        ? { "404": { description: "No such resource.", content: { "application/json": { schema: { type: "object" } } } } }
        : {}),
    },
  };
}

function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of PUBLIC_ENDPOINTS) {
    const p = openApiPath(e.path);
    paths[p] ??= {};
    paths[p][e.method.toLowerCase()] = operation(e);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Robot Money public API",
      version: "1",
      summary: "Every number on robotmoney.network, callable directly.",
      description: [
        "robotmoney.network renders in the browser, so fetching a page URL returns the shell and none of the data.",
        "This is the surface that holds the data instead. Every operation below is a public, unauthenticated GET:",
        "no key, no signup, no rate limit beyond ordinary abuse protection. Absolute URLs are given so an agent",
        "whose fetch tool only follows URLs it has already read can take them straight from this document.",
        "",
        "Read /health first and check `env`: a deployment answering with an `env` other than `prod` is serving",
        "demo or staging data.",
        "",
        "Credentialed surfaces (admin lifecycle, analytics-provider ingestion, member take submission) are",
        "deliberately absent. The member write flow is documented at " + ORIGIN + "/docs/investment-swarm/api-reference.",
      ].join("\n"),
      license: { name: "Public data", url: ORIGIN + "/disclaimer" },
      contact: { name: "Robot Money", url: ORIGIN },
    },
    servers: [{ url: ORIGIN, description: "Production" }],
    tags: [{ name: "public-read", description: "Public, unauthenticated reads." }],
    externalDocs: { description: "llms.txt site index", url: ORIGIN + "/llms.txt" },
    paths,
  };
}

// ── llms.txt endpoint block ────────────────────────────────────────────────

function buildLlmsBlock(): string {
  const lines: string[] = [];
  lines.push("## Live data (JSON API, no key required)");
  lines.push("");
  lines.push(
    "Every number on this site is served by these endpoints. They answer a plain GET with JSON and need no authentication. Full description: [openapi.json](" +
      ORIGIN +
      "/openapi.json). Check [/health](" +
      ORIGIN +
      "/health) first: an `env` other than `prod` means demo or staging data.",
  );
  lines.push("");
  for (const e of PUBLIC_ENDPOINTS) {
    if (e.path === "/health") continue;
    const url = ORIGIN + openApiPath(e.path);
    const size = e.sizeHint ? ` ${e.sizeHint[0].toUpperCase()}${e.sizeHint.slice(1)}.` : "";
    // A URL carrying a {placeholder} is not fetchable, so it is written as code
    // rather than as a link: a link invites a crawler to request the literal
    // template and record a 404. The ids that fill it come out of the
    // collection endpoint listed above it.
    const target = e.params?.some((p) => p.in === "path") ? `\`${url}\`` : `[${url}](${url})`;
    lines.push(`- ${target}: ${e.summary}.${size}`);
  }
  return lines.join("\n");
}

// ── run ────────────────────────────────────────────────────────────────────

const drift = assertCatalogCoversRoutes();
const stale = assertCatalogPathsExist();
if (stale.length) {
  console.error("Catalogued paths that no longer exist in ROUTES:\n  " + stale.join("\n  "));
  process.exit(1);
}
if (drift.length) {
  console.error(
    "Public routes in ROUTES that scripts/lib/agent-endpoints.ts neither catalogues nor excludes:\n  " +
      drift.join("\n  ") +
      "\n\nAdd them to PUBLIC_ENDPOINTS, or to EXCLUDED_ROUTES with a reason.",
  );
  process.exit(1);
}

const openApiText = JSON.stringify(buildOpenApi(), null, 2) + "\n";

const llmsText = await Bun.file(llmsFile).text();
if (!llmsText.includes(BEGIN) || !llmsText.includes(END)) {
  console.error(`${llmsFile} is missing the generated-endpoint markers.\n  ${BEGIN}\n  ${END}`);
  process.exit(1);
}
const before = llmsText.slice(0, llmsText.indexOf(BEGIN) + BEGIN.length);
const after = llmsText.slice(llmsText.indexOf(END));
const nextLlms = `${before}\n\n${buildLlmsBlock()}\n\n${after}`;

if (check) {
  const problems: string[] = [];
  if ((await Bun.file(openApiFile).text().catch(() => "")) !== openApiText) problems.push("frontend/public/openapi.json");
  if (llmsText !== nextLlms) problems.push("frontend/public/llms.txt");
  if (problems.length) {
    console.error("Out of date, run `bun run build:agent-surface`:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`agent surface up to date (${PUBLIC_ENDPOINTS.length} public endpoints)`);
} else {
  await Bun.write(openApiFile, openApiText);
  await Bun.write(llmsFile, nextLlms);
  console.log(`wrote openapi.json and the llms.txt endpoint block (${PUBLIC_ENDPOINTS.length} public endpoints)`);
}
