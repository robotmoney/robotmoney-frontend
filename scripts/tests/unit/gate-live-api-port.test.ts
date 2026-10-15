// The api's host port is asked of the daemon, never read from the stack record.
//
// A restarted container is given a new ephemeral host port. On the v0.6.2 stage
// QA run of 2026-10-15 the api restarted twice after the rolling boot, its port
// moved from 32975 (the record) to 32977, and S08-soak-checks read /health as
// "unreachable" from a healthy api.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDockerPort } from "../../lib/gate/io.ts";
import { API_CONTAINER_PORT, liveApiBase } from "../../lib/gate/stack.ts";

describe("the api's live host port", () => {
  test("docker port's output parses to its host port, for either address family", () => {
    expect(parseDockerPort("0.0.0.0:32977\n[::]:32977\n")).toBe(32977);
    expect(parseDockerPort("[::]:41000\n")).toBe(41000);
    expect(parseDockerPort("")).toBeNull();
    expect(parseDockerPort("Error: No public port '8787/tcp' published for x\n")).toBeNull();
  });

  test("liveApiBase asks for the container's 8787 now and refuses a container that publishes none", () => {
    const asked: [string, number][] = [];
    const base = liveApiBase({ api: "p-api-1" }, { liveHostPort: (c, p) => { asked.push([c, p]); return 32977; } });
    expect(base).toBe("http://127.0.0.1:32977");
    expect(asked).toEqual([["p-api-1", API_CONTAINER_PORT]]);
    expect(() => liveApiBase({ api: "p-api-1" }, { liveHostPort: () => null })).toThrow("publishes no host port");
  });

  test("red: no release tool builds the api URL from the stack record's apiPort", () => {
    for (const f of ["standing-soak.ts", "twin-accelerate.ts", "prod-init.ts"]) {
      const text = readFileSync(join(import.meta.dir, "..", "..", f), "utf8");
      expect(text, f).not.toMatch(/record\??\.apiPort|recorded\??\.apiPort/);
    }
  });
});
