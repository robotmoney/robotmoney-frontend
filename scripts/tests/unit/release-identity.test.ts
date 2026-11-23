// Issue 1713: the footer's release line. Formatter rows, plus version.json's
// committedAt against git.
import { describe, expect, test } from "bun:test";
import { formatReleaseIdentity, DASH } from "../../../frontend/public/assets/js/app/lib/release-identity.js";
import { webClientVersion, repoRoot } from "../../web-client/version.ts";

const SITE = { name: "@robotmoney/web-client", version: "0.2.1", commit: "3b13bd37", apiRange: "^0.5.0", committedAt: "2026-11-12T14:03:27.000Z" };

describe("formatReleaseIdentity", () => {
  test("full inputs: bare versions get web- and platform- prefixes", () => {
    expect(formatReleaseIdentity(SITE, { version: "0.9.0", api: "0.5.3", commit: "abcdef12" }))
      .toBe("web-0.2.1 · platform-0.9.0 · 3b13bd37 · 2026-11-12 14:03 UTC");
  });

  test("today's {api, commit} response: the platform slot is a dash, never the contract version", () => {
    const line = formatReleaseIdentity(SITE, { api: "0.5.3", commit: "abcdef12" });
    expect(line).toBe(`web-0.2.1 · ${DASH} · 3b13bd37 · 2026-11-12 14:03 UTC`);
    expect(line).not.toContain("0.5.3");
  });

  test("null and unreadable fields are dashes", () => {
    expect(formatReleaseIdentity(null, null)).toBe([DASH, DASH, DASH, DASH].join(" · "));
    expect(formatReleaseIdentity({ version: 7, commit: "unknown", committedAt: "nope" }, { version: "" }))
      .toBe([DASH, DASH, DASH, DASH].join(" · "));
  });

  test("a long commit is cut to 8 characters", () => {
    expect(formatReleaseIdentity({ ...SITE, commit: "3b13bd37aa11bb22cc33dd44ee55ff6677889900" }, null)).toContain(" · 3b13bd37 · ");
  });

  test("never an -rc suffix", () => {
    const line = formatReleaseIdentity({ ...SITE, version: "0.2.1-rc.0" }, { version: "0.9.0-rc.2" });
    expect(line).toBe("web-0.2.1 · platform-0.9.0 · 3b13bd37 · 2026-11-12 14:03 UTC");
    expect(line).not.toContain("rc");
  });
});

describe("version.json committedAt", () => {
  test("equals HEAD's commit time as UTC ISO", async () => {
    const v = await webClientVersion();
    const git = Bun.spawnSync(["git", "log", "-1", "--format=%cI", "HEAD"], { cwd: repoRoot, stdout: "pipe" });
    expect(git.exitCode).toBe(0);
    expect(v.committedAt).toBe(new Date(git.stdout.toString().trim()).toISOString());
  });
});
