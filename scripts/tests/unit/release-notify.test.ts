// scripts/tests/unit/release-notify.test.ts — the stage run's one owner
// notification (scripts/release/notify.ts, issue 1555).
//
// gh is never called: `collect` is a fake that answers by command fragment and
// records every command it was given.
import { describe, expect, test } from "bun:test";
import { notificationBody, notify, type StopEvent } from "../../release/notify.ts";

const EVENT: StopEvent = {
  release: "v0.0.1",
  target: "stage",
  runTs: "20261104T120000Z",
  kind: "failed",
  step: "Q36-sdk-quickstart",
  detail: "1 step(s) failed: Q36-sdk-quickstart",
  resume: "bun run release:run --target stage --go go.txt --run 20261104T120000Z --from Q36-sdk-quickstart",
  at: "2026-11-04T12:00:00.000Z",
};

function fakeGh(list: { code: number; stdout: string }, comment = { code: 0, stdout: "" }) {
  const calls: string[] = [];
  const errors: string[] = [];
  return {
    calls,
    errors,
    deps: {
      async collect(_host: string, remote: string) {
        calls.push(remote);
        if (remote.includes("gh issue list")) return list;
        if (remote.includes("gh issue comment")) return comment;
        return { code: 1, stdout: "" };
      },
      error: (l: string) => errors.push(l),
    },
  };
}

describe("notify (issue 1555)", () => {
  test("it finds the one open release:<release> issue, then comments on it from stdin; the body names run, step, kind and resume", async () => {
    const gh = fakeGh({ code: 0, stdout: '[{"number":1555}]\n' });
    expect(await notify(EVENT, gh.deps)).toEqual({ notified: true, issue: 1555 });
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[0]).toContain("gh issue list --label release:v0.0.1 --state open --json number");
    expect(gh.calls[1]).toContain("| gh issue comment 1555 --body-file -");
    for (const part of [EVENT.runTs!, EVENT.step!, "kind: failed", EVENT.resume]) expect(gh.calls[1], part).toContain(part);
    expect(gh.errors).toEqual([]);
  });

  test("a password-shaped value is scrubbed before gh sees it", async () => {
    const gh = fakeGh({ code: 0, stdout: '[{"number":7}]' });
    const leaky = { ...EVENT, detail: "psql postgres://rm_owner:hunter2secret@db:5432/rm failed; PGPASSWORD=s3cr3tvalue" };
    expect(notificationBody(leaky)).not.toContain("hunter2secret");
    await notify(leaky, gh.deps);
    const all = gh.calls.join("\n");
    expect(all).not.toContain("hunter2secret");
    expect(all).not.toContain("s3cr3tvalue");
    expect(all).toContain("postgres://rm_owner:***@");
    expect(all).toContain("PGPASSWORD=***");
  });

  test("zero or two labelled issues, or gh exiting 1, prints the message to stderr, returns notified false, and does not throw", async () => {
    const cases: { list: { code: number; stdout: string }; comment?: { code: number; stdout: string }; reason: string }[] = [
      { list: { code: 0, stdout: "[]" }, reason: "0 open issues carry the label release:v0.0.1" },
      { list: { code: 0, stdout: '[{"number":1},{"number":2}]' }, reason: "2 open issues carry the label release:v0.0.1" },
      { list: { code: 1, stdout: "" }, reason: "gh issue list exited 1" },
      { list: { code: 0, stdout: '[{"number":3}]' }, comment: { code: 1, stdout: "" }, reason: "gh issue comment exited 1" },
    ];
    for (const c of cases) {
      const gh = fakeGh(c.list, c.comment);
      const r = await notify(EVENT, gh.deps);
      expect(r.notified, c.reason).toBe(false);
      expect("reason" in r && r.reason, c.reason).toContain(c.reason);
      expect(gh.errors.join("\n"), c.reason).toContain(EVENT.resume);
      expect(gh.errors.join("\n"), c.reason).toContain(c.reason);
    }
    // No comment is posted when the lookup fails.
    const none = fakeGh({ code: 0, stdout: "[]" });
    await notify(EVENT, none.deps);
    expect(none.calls.some((c) => c.includes("gh issue comment"))).toBe(false);
    // A collect that throws is caught too.
    const errors: string[] = [];
    const thrown = await notify(EVENT, { collect: async () => { throw new Error("spawn gh ENOENT"); }, error: (l) => errors.push(l) });
    expect(thrown.notified).toBe(false);
    expect(errors.join("\n")).toContain("ENOENT");
  });
});
