#!/usr/bin/env bun
// scripts/release/identity-check.ts — release step R7.1, run ON THE TARGET HOST.
// Standing check SV.1.
//
//   bun scripts/release/identity-check.ts --origin <https://host> --commit <sha> --receipt-dir <dir>
//
// GET <origin>/api/version must carry the release commit; GET
// <origin>/version.json must name it too. Neither may say `+dirty` or
// `+unknown`. Writes identity-check.json to --receipt-dir.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** PURE. Every way the served identity is not the release's. */
export function identityProblems(apiText: string | null, siteText: string | null, commit: string): string[] {
  const out: string[] = [];
  if (apiText === null) out.push("/api/version did not answer 200");
  else {
    let body: { api?: unknown; commit?: unknown } | null = null;
    try { body = JSON.parse(apiText) as { api?: unknown; commit?: unknown }; } catch { out.push("/api/version is not JSON"); }
    if (body && body.commit !== commit) out.push(`/api/version commit is ${String(body.commit)}, expected ${commit}`);
    if (/\+(dirty|unknown)/.test(apiText)) out.push("/api/version carries +dirty or +unknown");
  }
  if (siteText === null) out.push("/version.json did not answer 200");
  else {
    // The site's build stamps its short commit (`"commit":"642a0057"`): a prefix of
    // at least 7 hex characters names the release commit; any other value does not.
    let site: { commit?: unknown } | null = null;
    try { site = JSON.parse(siteText) as { commit?: unknown }; } catch { out.push("/version.json is not JSON"); }
    const siteCommit = site && typeof site.commit === "string" ? site.commit.replace(/\+.*$/, "") : "";
    if (site && !(siteCommit.length >= 7 && /^[0-9a-f]+$/.test(siteCommit) && commit.startsWith(siteCommit))) {
      out.push(`/version.json commit is ${String(site.commit)}, which does not name ${commit}`);
    }
    if (/\+(dirty|unknown)/.test(siteText)) out.push("/version.json carries +dirty or +unknown");
  }
  return out;
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function get(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const origin = flag("--origin")?.replace(/\/+$/, "");
  const commit = flag("--commit");
  const receiptDir = flag("--receipt-dir");
  if (!origin || !commit || !/^[0-9a-f]{40}$/.test(commit) || !receiptDir) {
    console.error("usage: bun scripts/release/identity-check.ts --origin <url> --commit <sha> --receipt-dir <dir>");
    return 2;
  }
  const apiText = await get(`${origin}/api/version`);
  const siteText = await get(`${origin}/version.json`);
  const problems = identityProblems(apiText, siteText, commit);
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "identity-check.json");
  writeFileSync(file, `${JSON.stringify({ step: "R7.1", origin, commit, api: apiText, site: siteText, problems, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`[identity-check] ${origin}/api/version: ${apiText ?? "(no answer)"}`);
  console.log(`[identity-check] receipt: ${file}`);
  for (const p of problems) console.error(`[identity-check] FAIL: ${p}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
