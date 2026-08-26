// Unit tests for the pure half of `--db smoke-twin` (scripts/lib/smoke-twin.ts).
//
// The impure half — gpg decrypt, pg_restore, docker run — is exercised for real
// by a smoke-twin boot and by smoke:smoke-twin --once; there is no honest way to fake an
// encrypted production dump, and the same reasoning is already written down in
// backend/tests/restore-container.test.ts's header.
//
// What IS decided rather than performed, and therefore lives here:
//   - the volume name, because smoke:clean finds it by project scoping;
//   - assertSmokeTwinIsTarget, the single guard that replaced an entire isolated-git-
//     worktree apparatus, and the one whose failure mode is a rehearsal silently
//     running against production;
//   - the operator-facing narration, whose whole job is to not say "resume" for
//     something that discards data.
import { describe, expect, test } from "bun:test";
import {
  assertSmokeTwinIsTarget,
  smokeTwinUrlFromContainer,
  smokeTwinLeftRunningHint,
  smokeTwinResumeHint,
  smokeTwinTeardownNarration,
  smokeTwinVolumeName,
} from "../../lib/smoke-twin.ts";
import type { ResolvedDataPath } from "../../lib/smoke-db-mode.ts";

const TWIN: ResolvedDataPath = {
  kind: "smoke-twin",
  url: "postgres://restore_check:rk_secret@172.17.0.1:49155/rm_restore_check",
  redactedUrl: "postgres://restore_check:***@172.17.0.1:49155/rm_restore_check",
  container: "rm-restore-20260820T041946Z-85c0ld",
  volume: "rm_smoke_smoke-twintest_twin_20260820t041946z",
  stamp: "20260820T041946Z",
};
const EPHEMERAL: ResolvedDataPath = { kind: "ephemeral" };

describe("smokeTwinVolumeName", () => {
  test("is scoped by project, so smoke:clean's label filter reclaims it with the rest of the boot", () => {
    expect(smokeTwinVolumeName("rm_smoke_stack_abc", "20260820T041946Z")).toBe(
      "rm_smoke_stack_abc_smoke-twin_20260820t041946z",
    );
  });

  test("is lowercased — docker rejects the uppercase T/Z an ISO basic stamp carries", () => {
    expect(smokeTwinVolumeName("p", "20260820T041946Z")).toBe(smokeTwinVolumeName("p", "20260820T041946Z").toLowerCase());
  });

  test("two backups of the same project do not share a volume", () => {
    expect(smokeTwinVolumeName("p", "20260820T041946Z")).not.toBe(smokeTwinVolumeName("p", "20260819T161732Z"));
  });
});

describe("assertSmokeTwinIsTarget — the guard that replaced the isolated worktree", () => {
  test("passes when the stack really is pointed at the smoke-twin", () => {
    expect(() => assertSmokeTwinIsTarget({ DATABASE_URL: TWIN.url }, TWIN.url)).not.toThrow();
  });

  test("REFUSES when compose would dial something else — the production-.env case", () => {
    const prod = "postgres://doadmin:realpassword@prod-db.ondigitalocean.com:25060/defaultdb";
    expect(() => assertSmokeTwinIsTarget({ DATABASE_URL: prod }, TWIN.url)).toThrow(/refusing to boot/);
  });

  test("the refusal never prints the password it caught", () => {
    const prod = "postgres://doadmin:realpassword@prod-db.ondigitalocean.com:25060/defaultdb";
    try {
      assertSmokeTwinIsTarget({ DATABASE_URL: prod }, TWIN.url);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("realpassword");
      expect(msg).toContain("prod-db.ondigitalocean.com"); // the host IS named — that is the diagnosis
    }
  });

  test("an unset DATABASE_URL is a refusal, not a pass", () => {
    expect(() => assertSmokeTwinIsTarget({}, TWIN.url)).toThrow(/refusing to boot/);
  });
});

describe("operator narration", () => {
  test("teardown says the copy is KEPT and names the reclaim command", () => {
    const n = smokeTwinTeardownNarration(TWIN)!;
    expect(n).toContain("KEPT");
    expect(n).toContain(TWIN.volume);
    expect(n).toContain("smoke:clean");
  });

  test("teardown says nothing for a boot that had no smoke-twin", () => {
    expect(smokeTwinTeardownNarration(EPHEMERAL)).toBeUndefined();
  });

  test('the hint never says "resume" — a smoke-twin re-boot DISCARDS what the last run migrated', () => {
    const lines = smokeTwinResumeHint(TWIN).join(" ");
    expect(lines).not.toMatch(/resume/i);
    expect(lines).toMatch(/FRESH/);
  });

  test("the hint names the volume and the reclaim path", () => {
    const lines = smokeTwinResumeHint(TWIN).join(" ");
    expect(lines).toContain(TWIN.volume);
    expect(lines).toContain("smoke:clean");
  });

  test("no hint for a non-smoke-twin boot", () => {
    expect(smokeTwinResumeHint(EPHEMERAL)).toEqual([]);
  });

  test("the leave-running path names the container, or a copy of production leaks silently", () => {
    const lines = smokeTwinLeftRunningHint(TWIN.container).join(" ");
    expect(lines).toContain(TWIN.container);
    expect(lines).toContain("docker rm -f");
    expect(lines).toMatch(/STILL RUNNING/);
  });

  test("nothing to say when no smoke-twin was created", () => {
    expect(smokeTwinLeftRunningHint(undefined)).toEqual([]);
  });
});

// smokeTwinUrlFromContainer — how a release's postflight reaches the smoke-twin it must
// grade. The daemon call is injected, so what is under test is the assembly and,
// far more importantly, every path that must NOT produce a URL: the caller
// treats null as "this check could not run", and a wrong-but-plausible URL
// would instead be graded as a clean smoke-twin.
describe("smokeTwinUrlFromContainer", () => {
  const ENV = [
    "PATH=/usr/local/bin",
    "POSTGRES_USER=restore_check",
    "POSTGRES_PASSWORD=rk_9f1c2e",
    "POSTGRES_DB=rm_restore_check",
    "PGDATA=/var/lib/postgresql/18/docker",
  ].join("\n");
  const fake = (over: Record<string, string> = {}) => (format: string) => {
    if (format.includes("HostIp")) return over.host ?? "172.17.0.1";
    if (format.includes("HostPort")) return over.port ?? "49155";
    return over.env ?? ENV;
  };

  test("assembles the URL the smoke-twin's own container reports", () => {
    expect(smokeTwinUrlFromContainer("rm-restore-x", fake())).toBe(
      "postgres://restore_check:rk_9f1c2e@172.17.0.1:49155/rm_restore_check",
    );
  });

  test("percent-encodes credentials rather than emitting an unparseable URL", () => {
    const env = ENV.replace("rk_9f1c2e", "rk_a/b@c");
    expect(smokeTwinUrlFromContainer("rm-restore-x", fake({ env }))).toContain("rk_a%2Fb%40c");
  });

  test("keeps the LAST '=' of an env line inside the value", () => {
    const env = "POSTGRES_USER=restore_check\nPOSTGRES_PASSWORD=rk_a=b\nPOSTGRES_DB=rm_restore_check";
    expect(smokeTwinUrlFromContainer("rm-restore-x", fake({ env }))).toContain("rk_a%3Db");
  });

  test.each([
    ["a container the daemon does not know", { host: "", port: "", env: "" }],
    ["a container with no published 5432", { port: "" }],
    ["a container that publishes no host address", { host: "" }],
    ["an environment missing the password", { env: "POSTGRES_USER=u\nPOSTGRES_DB=d" }],
    ["an environment missing the user", { env: "POSTGRES_PASSWORD=p\nPOSTGRES_DB=d" }],
    ["an environment missing the database", { env: "POSTGRES_USER=u\nPOSTGRES_PASSWORD=p" }],
  ])("returns null for %s", (_label, over) => {
    expect(smokeTwinUrlFromContainer("rm-restore-x", fake(over))).toBeNull();
  });
});
