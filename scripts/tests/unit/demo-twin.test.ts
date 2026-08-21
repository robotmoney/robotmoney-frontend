// Unit tests for the pure half of `--db twin` (scripts/lib/demo-twin.ts).
//
// The impure half — gpg decrypt, pg_restore, docker run — is exercised for real
// by a twin boot and by twin:rehearse; there is no honest way to fake an
// encrypted production dump, and the same reasoning is already written down in
// backend/tests/restore-container.test.ts's header.
//
// What IS decided rather than performed, and therefore lives here:
//   - the volume name, because demo:clean finds it by project scoping;
//   - assertTwinIsTarget, the single guard that replaced an entire isolated-git-
//     worktree apparatus, and the one whose failure mode is a rehearsal silently
//     running against production;
//   - the operator-facing narration, whose whole job is to not say "resume" for
//     something that discards data.
import { describe, expect, test } from "bun:test";
import {
  assertTwinIsTarget,
  twinLeftRunningHint,
  twinResumeHint,
  twinTeardownNarration,
  twinVolumeName,
} from "../../lib/demo-twin.ts";
import type { ResolvedDataPath } from "../../lib/demo-db-mode.ts";

const TWIN: ResolvedDataPath = {
  kind: "twin",
  url: "postgres://restore_check:rk_secret@172.17.0.1:49155/rm_restore_check",
  redactedUrl: "postgres://restore_check:***@172.17.0.1:49155/rm_restore_check",
  container: "rm-restore-20260820T041946Z-85c0ld",
  volume: "rm_demo_twintest_twin_20260820t041946z",
  stamp: "20260820T041946Z",
};
const EPHEMERAL: ResolvedDataPath = { kind: "ephemeral" };

describe("twinVolumeName", () => {
  test("is scoped by project, so demo:clean's label filter reclaims it with the rest of the boot", () => {
    expect(twinVolumeName("rm_demo_stack_abc", "20260820T041946Z")).toBe(
      "rm_demo_stack_abc_twin_20260820t041946z",
    );
  });

  test("is lowercased — docker rejects the uppercase T/Z an ISO basic stamp carries", () => {
    expect(twinVolumeName("p", "20260820T041946Z")).toBe(twinVolumeName("p", "20260820T041946Z").toLowerCase());
  });

  test("two backups of the same project do not share a volume", () => {
    expect(twinVolumeName("p", "20260820T041946Z")).not.toBe(twinVolumeName("p", "20260819T161732Z"));
  });
});

describe("assertTwinIsTarget — the guard that replaced the isolated worktree", () => {
  test("passes when the stack really is pointed at the twin", () => {
    expect(() => assertTwinIsTarget({ DATABASE_URL: TWIN.url }, TWIN.url)).not.toThrow();
  });

  test("REFUSES when compose would dial something else — the production-.env case", () => {
    const prod = "postgres://doadmin:realpassword@prod-db.ondigitalocean.com:25060/defaultdb";
    expect(() => assertTwinIsTarget({ DATABASE_URL: prod }, TWIN.url)).toThrow(/refusing to boot/);
  });

  test("the refusal never prints the password it caught", () => {
    const prod = "postgres://doadmin:realpassword@prod-db.ondigitalocean.com:25060/defaultdb";
    try {
      assertTwinIsTarget({ DATABASE_URL: prod }, TWIN.url);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("realpassword");
      expect(msg).toContain("prod-db.ondigitalocean.com"); // the host IS named — that is the diagnosis
    }
  });

  test("an unset DATABASE_URL is a refusal, not a pass", () => {
    expect(() => assertTwinIsTarget({}, TWIN.url)).toThrow(/refusing to boot/);
  });
});

describe("operator narration", () => {
  test("teardown says the copy is KEPT and names the reclaim command", () => {
    const n = twinTeardownNarration(TWIN)!;
    expect(n).toContain("KEPT");
    expect(n).toContain(TWIN.volume);
    expect(n).toContain("demo:clean");
  });

  test("teardown says nothing for a boot that had no twin", () => {
    expect(twinTeardownNarration(EPHEMERAL)).toBeUndefined();
  });

  test('the hint never says "resume" — a twin re-boot DISCARDS what the last run migrated', () => {
    const lines = twinResumeHint(TWIN).join(" ");
    expect(lines).not.toMatch(/resume/i);
    expect(lines).toMatch(/FRESH/);
  });

  test("the hint names the volume and the reclaim path", () => {
    const lines = twinResumeHint(TWIN).join(" ");
    expect(lines).toContain(TWIN.volume);
    expect(lines).toContain("demo:clean");
  });

  test("no hint for a non-twin boot", () => {
    expect(twinResumeHint(EPHEMERAL)).toEqual([]);
  });

  test("the leave-running path names the container, or a copy of production leaks silently", () => {
    const lines = twinLeftRunningHint(TWIN.container).join(" ");
    expect(lines).toContain(TWIN.container);
    expect(lines).toContain("docker rm -f");
    expect(lines).toMatch(/STILL RUNNING/);
  });

  test("nothing to say when no twin was created", () => {
    expect(twinLeftRunningHint(undefined)).toEqual([]);
  });
});
