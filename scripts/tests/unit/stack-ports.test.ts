// Pure unit tests for scripts/stack/ports.ts — no Docker, no network beyond
// binding loopback sockets the test itself releases.
//
// What this file is really defending: the property that EVERY published host
// port is drawn free on every run, with exactly one sanctioned exception. The
// previous shape (an api port that "preferred" 48787 plus WEB_PORT/POSTGRES_PORT
// env pins) raced the standing stage demo for the cloudflared origin and took
// the site down, so "no fixed default" is a behaviour under test here, not a
// convention.
import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  allocatePorts,
  describePortHolders,
  IGNORED_PORT_ENV_VARS,
  PortUnavailableError,
  stackPortRequests,
  stalePortEnvWarnings,
  STAGE_WEB_PORT,
  type CommandResult,
} from "../../stack/ports.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

// Bind a loopback port and hold it for the duration of `fn`, so "this port is
// taken" is a real kernel fact rather than a mock.
async function holding<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
}

describe("port policy — random always, no fixed default", () => {
  test("an ordinary (non-stage) stack requests NOTHING fixed: both ports are free draws", () => {
    const [web, pg] = stackPortRequests({ stage: false });
    expect(web).toEqual({});
    expect(pg).toEqual({});
  });

  test("both allocated ports are real, distinct, and neither is a hard-coded default", async () => {
    const [api, pg] = stackPortRequests({ stage: false });
    const [apiPort, pgPort] = await allocatePorts([api, pg]);
    expect(apiPort).toBeGreaterThan(1024);
    expect(pgPort).toBeGreaterThan(1024);
    expect(apiPort).not.toBe(pgPort);
    // The two literals this change exists to delete.
    expect(apiPort).not.toBe(STAGE_WEB_PORT);
    expect(pgPort).not.toBe(5432);
  });

  test("two random draws never collide — every socket is held until both are chosen", async () => {
    // Looped: a fork that closed each socket before drawing the next would
    // eventually hand out the same port twice, which is precisely the
    // regression this batch API exists to prevent.
    for (let i = 0; i < 20; i++) {
      const [a, b] = await allocatePorts([{}, {}]);
      expect(a).not.toBe(b);
    }
  });

  test("allocated ports are usable afterwards (every held socket is released)", async () => {
    const [p] = await allocatePorts([{}]);
    const again = await allocatePorts([{ required: p! }]);
    expect(again).toEqual([p]);
  });
});

describe("--stage — the ONE pinned port", () => {
  test("pins the web port to the tunnel origin and leaves postgres random", async () => {
    const [web, pg] = stackPortRequests({ stage: true });
    expect(web.required).toBe(STAGE_WEB_PORT);
    expect(web.purpose).toContain("stage");
    // Postgres is NEVER pinned: nothing external routes to it, and a
    // predictable database port on a shared host is a liability.
    expect(pg).toEqual({});
  });

  test("the stage pin is the ONLY fixed port the builder can ever produce", () => {
    for (const stage of [true, false]) {
      const reqs = stackPortRequests({ stage });
      const fixed = reqs.filter((r) => r.required !== undefined).map((r) => r.required);
      expect(fixed).toEqual(stage ? [STAGE_WEB_PORT] : []);
    }
  });

  test("a FREE required port is taken as-is", async () => {
    // Draw one, release it, then require exactly it.
    const [p] = await allocatePorts([{}]);
    expect(await allocatePorts([{ required: p!, purpose: "test" }])).toEqual([p]);
  });

  test("a HELD required port FAILS LOUDLY — never a silent fallback to a random port", async () => {
    await holding(async (port) => {
      let thrown: unknown;
      try {
        await allocatePorts([{ required: port, purpose: "web/api (--stage)" }]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(PortUnavailableError);
      const err = thrown as PortUnavailableError;
      expect(err.port).toBe(port);
      expect(err.purpose).toContain("--stage");
      // The message must say REQUIRED, because the failure mode being prevented
      // is an operator reading "port busy" as "so it picked another one".
      expect(err.message).toContain("REQUIRED");
      expect(err.message).toContain(String(port));
    });
  });

  test("a held required port does not leak the other ports it was batched with", async () => {
    await holding(async (port) => {
      await expect(allocatePorts([{ required: port }, {}])).rejects.toThrow(PortUnavailableError);
      // The batch's already-held sockets are released in the finally, so the
      // very next allocation still works.
      const [again] = await allocatePorts([{}]);
      expect(again).toBeGreaterThan(1024);
    });
  });
});

describe("stale WEB_PORT / POSTGRES_PORT are IGNORED, loudly", () => {
  test("a clean environment produces no warnings", () => {
    expect(stalePortEnvWarnings({})).toEqual([]);
    expect(stalePortEnvWarnings({ WEB_PORT: "", POSTGRES_PORT: "   " })).toEqual([]);
  });

  test("each stale pin gets its own warning naming the var, its value, and that it is IGNORED", () => {
    const w = stalePortEnvWarnings({ WEB_PORT: "48787", POSTGRES_PORT: "5432" });
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("WEB_PORT=48787");
    expect(w[0]).toContain("IGNORED");
    expect(w[1]).toContain("POSTGRES_PORT=5432");
    expect(w[1]).toContain("IGNORED");
    // It must point at the remaining sanctioned mechanism, or the operator's
    // next move is to re-export the variable somewhere else.
    for (const line of w) expect(line).toContain("--stage");
  });

  test("a stale pin cannot influence what is allocated — the builder takes no environment at all", () => {
    // stackPortRequests has no env parameter by construction; assert the shape
    // it produces is identical regardless of what is exported.
    const before = JSON.stringify(stackPortRequests({ stage: false }));
    const saved = { WEB_PORT: process.env.WEB_PORT, POSTGRES_PORT: process.env.POSTGRES_PORT };
    process.env.WEB_PORT = "48787";
    process.env.POSTGRES_PORT = "5432";
    try {
      expect(JSON.stringify(stackPortRequests({ stage: false }))).toBe(before);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("the ignored-var list is exactly the two names compose still interpolates as OUTPUTS", () => {
    expect([...IGNORED_PORT_ENV_VARS]).toEqual(["WEB_PORT", "POSTGRES_PORT"]);
  });
});

describe("describePortHolders — the diagnostic on a failed stage pin", () => {
  const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

  test("names the container publishing the port and the listening socket", () => {
    const out = describePortHolders(48787, (cmd) => {
      if (cmd[1] === "ps") return ok("abc123  rm_demo_stack_aa11-api-1  robotmoney/api  0.0.0.0:48787->8787/tcp\n");
      return ok('LISTEN 0 4096 0.0.0.0:48787 0.0.0.0:* users:(("docker-proxy",pid=999,fd=4))\n');
    });
    expect(out).toContain("rm_demo_stack_aa11-api-1");
    expect(out).toContain("docker-proxy");
    expect(out).toContain("pid=999");
  });

  test("a similarly-numbered port on another line is not mistaken for the holder", () => {
    const out = describePortHolders(4878, (cmd) => {
      if (cmd[1] === "ps") return ok("");
      return ok('LISTEN 0 4096 0.0.0.0:48787 0.0.0.0:* users:(("docker-proxy",pid=999,fd=4))\n');
    });
    expect(out).not.toContain("pid=999");
    expect(out).toContain("none matched");
  });

  test("a broken probe degrades to a stated reason — it never throws over the error it explains", () => {
    const out = describePortHolders(48787, () => ({ exitCode: 127, stdout: "", stderr: "command not found" }));
    expect(out).toContain("could not be consulted");
    expect(out).toContain("command not found");
  });

  test("the docker probe filters on the port rather than listing everything", () => {
    const seen: string[][] = [];
    describePortHolders(48787, (cmd) => {
      seen.push(cmd);
      return ok("");
    });
    expect(seen[0]).toContain("--filter");
    expect(seen[0]).toContain("publish=48787");
    expect(seen[1]).toEqual(["ss", "-tlnp"]);
  });
});

// ── Source/config guards ────────────────────────────────────────────────────
// These read the real on-disk files and assert, so they are executed coverage
// (test-coverage policy), not doc-grep standing in for behaviour: the artefacts
// asserted here are compose interpolation defaults and an entrypoint code path,
// neither of which any unit test can otherwise reach (demo-main.ts boots a
// stack at module scope and cannot be imported).
describe("no fixed host-port default survives anywhere", () => {
  // EFFECTIVE lines only — the prose in this compose file explains the removed
  // `${WEB_PORT:-48787}` default by quoting it, and a guard that could not tell
  // a comment from a directive would forbid documenting the very change it
  // guards.
  const composeLines = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"));
  const compose = composeLines.join("\n");

  test("docker-compose.yml REQUIRES both host ports (`:?`) instead of defaulting them", () => {
    expect(compose).toContain("${WEB_PORT:?");
    expect(compose).toContain("${POSTGRES_PORT:?");
    expect(composeLines.filter((l) => l.includes("${WEB_PORT:-"))).toEqual([]);
    expect(composeLines.filter((l) => l.includes("${POSTGRES_PORT:-"))).toEqual([]);
  });

  test("the container-internal api port stays the literal 8787 and is not a knob", () => {
    expect(compose).toContain(':8787"');
    // A compose-set API_PORT made the host `.env` value look effective while
    // compose overrode it; the single default now lives in backend/src/config.ts.
    expect(composeLines.filter((l) => /^\s*API_PORT:/.test(l))).toEqual([]);
  });

  test(".env.example ships no host-port pin (an operator copying it must not re-create the outage)", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    for (const line of example.split("\n")) {
      const t = line.trim();
      if (t.startsWith("#")) continue; // prose explaining the removal is fine
      expect(t).not.toMatch(/^(WEB_PORT|POSTGRES_PORT|API_PORT)=/);
    }
  });

  test("the demo entrypoint no longer reads a port pin from the environment", () => {
    const src = readFileSync(join(repoRoot, "scripts", "lib", "demo-main.ts"), "utf8");
    expect(src).not.toContain("process.env.WEB_PORT");
    expect(src).not.toContain("process.env.POSTGRES_PORT");
    expect(src).not.toContain("parsePort");
    // ...and it does still WARN about them, which is the loud half of the rule.
    expect(src).toContain("stalePortEnvWarnings");
  });
});
