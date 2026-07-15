// Guard against the retired PROVIDER/analyticsProvider chain regrowing
// (review-maintainability-011). The chain was: process.env.PROVIDER →
// config.analyticsProvider → access/fetcher-provider.ts (test-only scaffolding
// living in src/) — all dead, all deleted. The ONLY legitimate survivor of the
// name is the committee route's AUTH predicate for the analytics-provider ROLE,
// renamed hasAnalyticsProviderRole precisely so a grep for the data-source knob
// can never land in the auth path again.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const grep = (re: RegExp) =>
  files.flatMap((file) => {
    const hits: string[] = [];
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
    return hits;
  });

test("backend/src has real files to scan (walker sanity)", () => {
  expect(files.length).toBeGreaterThan(10);
});

test("no code reads process.env.PROVIDER", () => {
  expect(grep(/process\.env\.PROVIDER\b/)).toEqual([]);
});

test("the exact identifier `analyticsProvider` no longer exists (config field + collisions)", () => {
  expect(grep(/\banalyticsProvider\b/)).toEqual([]);
});

test("fetcher-provider scaffolding is gone from src (file and references)", () => {
  expect(files.filter((f) => f.includes("fetcher-provider"))).toEqual([]);
  expect(grep(/fetcher-provider|FetcherProvider/)).toEqual([]);
});

test("the only analyticsprovider-ish identifier is the shared auth predicate", () => {
  // Case-insensitive sweep: every match must be the auth predicate
  // hasAnalyticsProviderRole — defined in api/auth.ts (issue #106 extracted it
  // from the committee router so the /api/analytics boundary reuses the same
  // constant-time check) and referenced only by the API routers that gate the
  // analytics-provider ROLE. (The hyphenated "analytics-provider" ROLE string
  // is a different, legitimate concept and cannot match this regex.)
  const allowedFiles = [
    join("api", "auth.ts"),
    join("api", "routes", "committee.ts"),
    join("api", "routes", "analytics.ts"),
  ];
  const hits = grep(/analyticsprovider/i);
  expect(hits.length).toBeGreaterThan(0); // the predicate itself must survive
  for (const hit of hits) {
    expect(allowedFiles.some((f) => hit.includes(f))).toBe(true);
    expect(hit).toContain("hasAnalyticsProviderRole");
  }
});
