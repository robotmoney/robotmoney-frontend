// The driver seats its members before the scheduler opens the epoch (#1026).
//
// An epoch freezes its expected roster when it opens (backend/src/swarm/epoch.ts
// insertEpoch). A member registered afterwards is refused at submit with 403
// "member is not on this session's expected roster" (CI run 36654372588: athena,
// boreas and cygnus all ran the model, then failed on that). The subject's
// creation is what makes the scheduler open the epoch, so every member must be
// registered before that call.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_MEMBERS, enrollRoster } from "../../lib/swarm/session.ts";

const source = readFileSync(join(import.meta.dir, "../../lib/swarm/session.ts"), "utf8");

describe("enrollRoster", () => {
  test("enrolls every member, present or no-show", async () => {
    const seen: string[] = [];
    await enrollRoster({} as never, DEMO_MEMBERS, (async (_rail: unknown, m: { memberId: string }) => {
      seen.push(m.memberId);
    }) as never);
    expect(seen.sort()).toEqual(DEMO_MEMBERS.map((m) => m.memberId).sort());
  });

  test("one failed enrollment does not stop the others", async () => {
    const seen: string[] = [];
    await enrollRoster({} as never, DEMO_MEMBERS, (async (_rail: unknown, m: { memberId: string }) => {
      if (m.memberId === "athena") throw new Error("boom");
      seen.push(m.memberId);
    }) as never);
    expect(seen).toHaveLength(DEMO_MEMBERS.length - 1);
  });
});

describe("the order of the driver's calls", () => {
  const firstIndexAfter = (marker: string, needle: string): number => source.indexOf(needle, source.indexOf(marker));

  test("runSession enrolls before it creates the subject that opens the epoch", () => {
    const start = "export async function runSession(";
    expect(firstIndexAfter(start, "await enrollRoster(")).toBeGreaterThan(0);
    expect(firstIndexAfter(start, "await enrollRoster(")).toBeLessThan(firstIndexAfter(start, "await ensureSubjectViaAdmin("));
  });

  test("main enrolls before it creates the first subject", () => {
    const start = "async function main()";
    expect(firstIndexAfter(start, "await enrollRoster(")).toBeLessThan(firstIndexAfter(start, "await ensureSubjectViaAdmin("));
  });

  test("no member enrolls after the epoch is open", () => {
    const afterOpen = source.slice(source.indexOf("const opened = await waitForSchedulerEpoch("), source.indexOf("async function main()"));
    expect(afterOpen).not.toMatch(/\benroll\(rail/);
  });
});
