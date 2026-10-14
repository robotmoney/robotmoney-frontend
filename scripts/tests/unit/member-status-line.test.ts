// Issue 1269: the status line a seat silent for the threshold's sessions shows
// on the public member page and the admin member list. The helper is the
// shipped client module, imported directly; the backend counts the number
// (backend/src/swarm/dormancy.ts) and its default threshold must be the page's.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memberStatusLine, SILENT_THRESHOLD_SESSIONS } from "../../../frontend/public/assets/js/app/lib/member-status.js";

const repoRoot = join(import.meta.dir, "..", "..", "..");

describe("memberStatusLine", () => {
  test("at the default threshold of 7 it names the count", () => {
    expect(SILENT_THRESHOLD_SESSIONS).toBe(7);
    expect(memberStatusLine({ silentSessions: 7 })).toBe("Silent: missed 7 consecutive sessions");
    expect(memberStatusLine({ silentSessions: 12 })).toBe("Silent: missed 12 consecutive sessions");
  });

  test("below the threshold, with no count, or with no member it is null", () => {
    expect(memberStatusLine({ silentSessions: 6 })).toBeNull();
    expect(memberStatusLine({ silentSessions: 0 })).toBeNull();
    expect(memberStatusLine({ silentSessions: null })).toBeNull();
    expect(memberStatusLine({})).toBeNull();
    expect(memberStatusLine(null)).toBeNull();
  });

  test("an explicit threshold moves the line", () => {
    expect(memberStatusLine({ silentSessions: 3 }, 3)).toBe("Silent: missed 3 consecutive sessions");
    expect(memberStatusLine({ silentSessions: 2 }, 3)).toBeNull();
  });

  test("the backend's default threshold is the page's", () => {
    const src = readFileSync(join(repoRoot, "backend/src/swarm/dormancy.ts"), "utf8");
    const m = src.match(/DEFAULT_SWARM_DORMANCY_THRESHOLD_SESSIONS = (\d+);/);
    expect(Number(m?.[1])).toBe(SILENT_THRESHOLD_SESSIONS);
  });

  test("the member page and the admin member list render it", () => {
    const member = readFileSync(join(repoRoot, "frontend/public/views/swarm/member.html"), "utf8");
    expect(member).toContain('data-testid="member-status-line" x-text="statusLine(member)"');
    const adminList = readFileSync(join(repoRoot, "frontend/public/views/admin/swarm.html"), "utf8");
    expect(adminList).toContain('x-text="memberStatusLine(m)" data-testid="member-status-line"');
  });
});
