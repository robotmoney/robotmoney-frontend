// The scheduler's health surface is read by host tools on the same machine and
// by nothing else, so its host publish is loopback-only. A CI boot once hit a
// Docker ephemeral-port collision between that loopback publish and another
// service's wildcard publish, and the "fix" was to widen the publish to every
// interface. That exposes the health surface (subject names, last errors) to
// the network. The collision is handled by a retry in the stack bring-up; this
// pin keeps the publish narrow.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");

function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("the scheduler's health port", () => {
  test("is published on loopback only", () => {
    const block = serviceBlock("system-scheduler");
    const publishes = [...block.matchAll(/^\s+- "([^"]*8090)"$/gm)].map((m) => m[1]);
    expect(publishes).toEqual(["127.0.0.1::8090"]);
  });

  test("the stack bring-up retries a services start that lost a port race", () => {
    const stack = readFileSync(join(repoRoot, "scripts", "stack", "stack.ts"), "utf8");
    expect(stack).toContain("START_SERVICES_ATTEMPTS");
    expect(stack).toMatch(/address already in use/);
  });
});
