// Pure unit tests for scripts/stack/ports.ts — no Docker, no network beyond
// binding loopback sockets the test itself releases.
//
// What this file is really defending: the property that NOBODY IN THIS REPO
// PICKS A HOST PORT. Two shapes have already failed in production. A fixed
// default (the api port "preferred" 48787) let a CI boot race the standing
// stage smoke for the cloudflared origin and take the site down. Its replacement
// — draw a free port ourselves, close the socket, hand the number to compose —
// swapped that for a TOCTOU race: anything on this shared host can take the
// port in the gap before compose binds it, and randomizing more stacks widened
// the gap. Docker now chooses and binds atomically, and we read back what it
// chose. So the assertions here are about PARSING the daemon's answer, about
// the one sanctioned pin, and about no allocator having crept back in.
import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertStageWebPortFree,
  describePortHolders,
  IGNORED_PORT_ENV_VARS,
  parseComposePortOutput,
  PortDiscoveryError,
  PortUnavailableError,
  stalePortEnvWarnings,
  STAGE_WEB_PORT,
  type CommandResult,
} from "../../stack/ports.ts";
import { API_CONTAINER_PORT, portArgs, POSTGRES_CONTAINER_PORT, STAGE_COMPOSE_FILE } from "../../stack/config.ts";

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

// A port the kernel just handed out and we immediately released — free at the
// instant it is returned, which is all these probe tests need.
function recentlyFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

describe("parseComposePortOutput — reading back what Docker assigned", () => {
  test("a single IPv4 binding yields that port", () => {
    expect(parseComposePortOutput("0.0.0.0:32768\n", "api", 8787)).toBe(32768);
  });

  test("the DUAL-STACK case: an IPv4 and an IPv6 line, and the IPv4 one wins", () => {
    // Docker publishes on both families and the two numbers are not guaranteed
    // equal. Everything host-side here talks to 127.0.0.1 (hostBackendUrl's
    // comment: "localhost" resolves ::1 first under Bun and breaks the CI
    // health check), so taking the IPv6 line would build a URL that times out.
    expect(parseComposePortOutput("0.0.0.0:32768\n[::]:32769\n", "api", 8787)).toBe(32768);
    // Order must not matter — compose has printed them both ways.
    expect(parseComposePortOutput("[::]:32769\n0.0.0.0:32768\n", "api", 8787)).toBe(32768);
  });

  test("a bare `::` IPv6 host is recognised as IPv6, not mistaken for IPv4", () => {
    expect(parseComposePortOutput(":::32769\n0.0.0.0:32768\n", "api", 8787)).toBe(32768);
  });

  test("an IPv6-ONLY result is accepted rather than refused", () => {
    // Refusing would turn a working stack into a failed boot over something the
    // operator cannot act on.
    expect(parseComposePortOutput("[::]:32769\n", "api", 8787)).toBe(32769);
  });

  test("a specific bind address (not 0.0.0.0) is still an IPv4 answer", () => {
    expect(parseComposePortOutput("127.0.0.1:41234\n", "postgres", 5432)).toBe(41234);
  });

  test("blank lines and stray whitespace are ignored", () => {
    expect(parseComposePortOutput("\n  0.0.0.0:32768  \n\n", "api", 8787)).toBe(32768);
  });

  test("EMPTY output THROWS — a service that publishes nothing must not read as a port", () => {
    let thrown: unknown;
    try {
      parseComposePortOutput("", "api", 8787);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PortDiscoveryError);
    const err = thrown as PortDiscoveryError;
    expect(err.service).toBe("api");
    expect(err.containerPort).toBe(8787);
    expect(err.message).toContain("no binding was reported at all");
  });

  test("MALFORMED output THROWS and quotes what it actually got", () => {
    // The failure an operator hits is "docker said something unexpected"; an
    // error that hides the something is unactionable.
    let thrown: unknown;
    try {
      parseComposePortOutput("no such service: api\n", "api", 8787);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PortDiscoveryError);
    expect((thrown as Error).message).toContain("no such service: api");
  });

  test("`:0` — compose's 'not published' — THROWS instead of becoming port 0", () => {
    // A caller that took the 0 would go on to build http://127.0.0.1:0.
    expect(() => parseComposePortOutput("0.0.0.0:0\n", "postgres", 5432)).toThrow(PortDiscoveryError);
    expect(() => parseComposePortOutput("0.0.0.0:0\n[::]:0\n", "postgres", 5432)).toThrow(PortDiscoveryError);
  });

  test("an out-of-range or non-numeric port is not a candidate", () => {
    expect(() => parseComposePortOutput("0.0.0.0:70000\n", "api", 8787)).toThrow(PortDiscoveryError);
    expect(() => parseComposePortOutput("0.0.0.0:abc\n", "api", 8787)).toThrow(PortDiscoveryError);
    // ...but a valid line alongside a junk one still resolves.
    expect(parseComposePortOutput("garbage\n0.0.0.0:32768\n", "api", 8787)).toBe(32768);
  });

  test("portArgs asks the daemon rather than guessing, per service", () => {
    expect(portArgs("api", API_CONTAINER_PORT)).toEqual(["port", "api", "8787"]);
    expect(portArgs("postgres", POSTGRES_CONTAINER_PORT)).toEqual(["port", "postgres", "5432"]);
  });
});

describe("--stage — the ONE pinned port, and its pre-flight", () => {
  test("a FREE port passes the pre-flight silently", async () => {
    await expect(assertStageWebPortFree(await recentlyFreePort(), "test")).resolves.toBeUndefined();
  });

  test("a HELD port FAILS LOUDLY — the pre-flight has no boolean to branch on", async () => {
    await holding(async (port) => {
      let thrown: unknown;
      try {
        await assertStageWebPortFree(port, "web/api (--stage)");
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

  test("the default subject is the cloudflared tunnel origin", () => {
    expect(STAGE_WEB_PORT).toBe(48787);
  });

  test("the pre-flight RELEASES the port it probed — it is a check, not a reservation", async () => {
    // This is the difference between this probe and the deleted allocator: a
    // reservation would leave the socket open and compose could never bind.
    const port = await recentlyFreePort();
    await assertStageWebPortFree(port, "test");
    // Still bindable immediately afterwards ⇒ nothing was held.
    await assertStageWebPortFree(port, "test");
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

  test("the ignored-var list is exactly the two names that used to pin a host port", () => {
    expect([...IGNORED_PORT_ENV_VARS]).toEqual(["WEB_PORT", "POSTGRES_PORT"]);
  });
});

describe("describePortHolders — the diagnostic on a failed stage pre-flight", () => {
  const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

  test("names the container publishing the port and the listening socket", () => {
    const out = describePortHolders(48787, (cmd) => {
      if (cmd[1] === "ps") return ok("abc123  rm_smoke_stack_aa11-api-1  robotmoney/api  0.0.0.0:48787->8787/tcp\n");
      return ok('LISTEN 0 4096 0.0.0.0:48787 0.0.0.0:* users:(("docker-proxy",pid=999,fd=4))\n');
    });
    expect(out).toContain("rm_smoke_stack_aa11-api-1");
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
// asserted here are compose publish declarations and an entrypoint code path,
// neither of which any unit test can otherwise reach (smoke-main.ts boots a
// stack at module scope and cannot be imported). The BEHAVIOURAL half — that
// `docker compose config` really resolves to exactly one api mapping — is
// asserted from real compose output in
// scripts/tests/integration/smoke-compose-config.test.ts, which is where a
// Docker dependency belongs.
describe("no host port is named anywhere except the stage overlay", () => {
  // EFFECTIVE lines only — the prose in these files explains the removed
  // `${WEB_PORT:-48787}` default by quoting it, and a guard that could not tell
  // a comment from a directive would forbid documenting the very change it
  // guards.
  const effective = (path: string) =>
    readFileSync(join(repoRoot, path), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"));
  const composeLines = effective("docker-compose.yml");
  const compose = composeLines.join("\n");
  const stageLines = effective(STAGE_COMPOSE_FILE);

  test("docker-compose.yml publishes CONTAINER PORTS ONLY — Docker assigns the host side", () => {
    // The short form: a quoted bare container port, no host half, no variable.
    const trimmed = composeLines.map((l) => l.trim());
    expect(trimmed).toContain(`- "${API_CONTAINER_PORT}"`);
    expect(trimmed).toContain(`- "${POSTGRES_CONTAINER_PORT}"`);
  });

  test("no `${WEB_PORT…}` / `${POSTGRES_PORT…}` interpolation survives — there is no host side to fill", () => {
    for (const v of IGNORED_PORT_ENV_VARS) {
      expect(composeLines.filter((l) => l.includes(`\${${v}`))).toEqual([]);
    }
  });

  test("no fixed host port appears in the base compose file at all", () => {
    // A `HOST:CONTAINER` mapping is exactly the shape that raced the tunnel.
    expect(composeLines.filter((l) => /^\s*-\s*"\d+:\d+"/.test(l))).toEqual([]);
    expect(compose).not.toContain(String(STAGE_WEB_PORT));
  });

  test("the container-internal api port stays the literal 8787 and is not a knob", () => {
    // A compose-set API_PORT made the host `.env` value look effective while
    // compose overrode it; the single default now lives in backend/src/config.ts.
    expect(composeLines.filter((l) => /^\s*API_PORT:/.test(l))).toEqual([]);
  });

  test("the stage overlay declares EXACTLY ONE api mapping, and does it with !override", () => {
    // Compose merges `ports` by APPENDING. A plain `ports:` here would publish
    // BOTH the base file's ephemeral binding and 48787 — verified against real
    // `docker compose config` output, which emits two entries without the tag.
    const portLines = stageLines.filter((l) => l.includes("ports:"));
    expect(portLines).toHaveLength(1);
    expect(portLines[0]).toContain("!override");
    expect(portLines[0]).toContain(`"${STAGE_WEB_PORT}:${API_CONTAINER_PORT}"`);
    // ...and it pins the api ONLY: postgres stays Docker-assigned under --stage
    // because nothing external routes to the database.
    expect(stageLines.filter((l) => /^\s{2}\S+:\s*$/.test(l)).map((l) => l.trim())).toEqual(["api:"]);
  });

  test(".env.example ships no host-port pin (an operator copying it must not re-create the outage)", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    for (const line of example.split("\n")) {
      const t = line.trim();
      if (t.startsWith("#")) continue; // prose explaining the removal is fine
      expect(t).not.toMatch(/^(WEB_PORT|POSTGRES_PORT|API_PORT)=/);
    }
  });

  test("the smoke entrypoint neither reads a port pin nor pre-binds one", () => {
    const src = readFileSync(join(repoRoot, "scripts", "lib", "smoke-main.ts"), "utf8");
    expect(src).not.toContain("process.env.WEB_PORT");
    expect(src).not.toContain("process.env.POSTGRES_PORT");
    // The deleted allocator. Its return is a number nobody else agreed to, and
    // that is the TOCTOU race this whole change removes.
    expect(src).not.toContain("allocatePorts");
    expect(src).not.toContain("stackPortRequests");
    // ...and it does still WARN about a stale pin, which is the loud half.
    expect(src).toContain("stalePortEnvWarnings");
  });

  test("the pre-bind allocator is gone from the stack module, not just from its call sites", () => {
    const ports = readFileSync(join(repoRoot, "scripts", "stack", "ports.ts"), "utf8");
    // A surviving helper is an invitation to re-introduce the race, so its
    // absence is the assertion — not merely that nothing calls it today.
    for (const gone of ["export function allocatePorts", "export function stackPortRequests", "interface PortRequest"]) {
      expect(ports).not.toContain(gone);
    }
    // The one bind left is the stage PRE-FLIGHT, which chooses nothing.
    expect(ports).toContain("export async function assertStageWebPortFree");
  });
});
