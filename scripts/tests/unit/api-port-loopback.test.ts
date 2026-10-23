// Issue 1422 §4.8 "One way in": only website-server may reach the api from off
// this host, because website-server sets X-Client-IP (the identity the public
// analytics limits key on) and replaces any a caller sent. So the api's host
// publish is loopback-only, like the scheduler's health port
// (scheduler-health-port-loopback.test.ts), and the stage overlay pins only
// website-server's port.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function serviceBlock(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("the api's port", () => {
  test("is published on loopback only in the base composition", () => {
    const block = serviceBlock(readFileSync(join(repoRoot, "docker-compose.yml"), "utf8"), "api");
    expect([...block.matchAll(/^\s+- "([^"]*8787)"$/gm)].map((m) => m[1])).toEqual(["127.0.0.1::8787"]);
  });

  test("the stage overlay publishes no api port of its own", () => {
    const stage = readFileSync(join(repoRoot, "docker-compose.stage.yml"), "utf8");
    expect(stage).not.toMatch(/\n  api:\n/);
  });
});
