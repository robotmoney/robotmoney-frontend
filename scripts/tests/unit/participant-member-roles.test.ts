// fetchMemberRoles (scripts/lib/participant-compose.ts) against the api that
// is not listening yet. On 2026-10-05 the stage-2 rehearsal's participants
// phase read the members route 244 ms before the api logged `listening`;
// docker-proxy accepted and closed the socket, Bun threw, and the boot failed
// and stopped the writers it had just started. A transport failure is retried
// to a deadline; an HTTP answer is final.
import { describe, expect, test } from "bun:test";
import { ROUTES } from "@robotmoney/contract";
import { fetchMemberRoles } from "../../lib/participant-compose.ts";

function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const members = (rows: { id: string; role: string }[]) => new Response(JSON.stringify({ members: rows }), { status: 200 });

describe("fetchMemberRoles waits for an api that is still starting", () => {
  test("a socket closed before the api listens is retried, and the first answer is returned", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    let n = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      n += 1;
      if (n < 3) throw new TypeError("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
      return members([{ id: "m-1", role: "member" }, { id: "j-1", role: "judge" }]);
    }) as unknown as typeof fetch;
    const roles = await fetchMemberRoles("http://127.0.0.1:32809/", "tok", fetchImpl, { deadlineMs: 5_000, now: clock.now, sleep: clock.sleep });
    expect([...roles.entries()]).toEqual([["m-1", { role: "member" }], ["j-1", { role: "judge" }]]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(`http://127.0.0.1:32809${ROUTES.swarm.admin.members}`);
    expect(clock.slept).toEqual([500, 500]);
  });

  test("an api that never listens refuses at the deadline, naming the last transport error and the attempts", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      throw new Error("connect ECONNREFUSED 127.0.0.1:32809");
    }) as unknown as typeof fetch;
    await expect(
      fetchMemberRoles("http://127.0.0.1:32809", "tok", fetchImpl, { deadlineMs: 1_200, now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow(/gave no answer in 4 attempt\(s\) over 1200 ms \(last: connect ECONNREFUSED 127\.0\.0\.1:32809\); the roster's roles cannot be checked/);
    expect(n).toBe(4);
    // Each sleep is bounded by what is left of the deadline: 500, 500, 200.
    expect(clock.slept).toEqual([500, 500, 200]);
  });

  test("an HTTP answer is never retried: a 503 refuses at once", async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response("later", { status: 503 });
    }) as unknown as typeof fetch;
    await expect(fetchMemberRoles("http://api", "tok", fetchImpl, { now: clock.now, sleep: clock.sleep })).rejects.toThrow(/answered HTTP 503/);
    expect(n).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  test("a 200 without a members list refuses at once, not as 'no members'", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchMemberRoles("http://api", "tok", fetchImpl)).rejects.toThrow(/without a members list/);
  });
});

import { resolveParticipantImage } from "../../lib/participant-compose.ts";

describe("resolveParticipantImage — the image participants run after a resume rebuilt the api (issue #1160)", () => {
  const present = (have: string[]) => (ref: string) => have.includes(ref);
  test("the running api's image, while Docker still has it", () => {
    expect(resolveParticipantImage("sha256:old", "rm_x-api:latest", present(["sha256:old", "rm_x-api:latest"]))).toEqual({ image: "sha256:old", fallback: null });
  });
  test("a pruned id falls back to the project's api tag, and says so", () => {
    const r = resolveParticipantImage("sha256:old", "rm_x-api:latest", present(["rm_x-api:latest"]));
    expect(r.image).toBe("rm_x-api:latest");
    expect(r.fallback).toMatch(/sha256:old is no longer in Docker .* participants start from rm_x-api:latest/);
  });
  test("neither present refuses, naming both", () => {
    expect(() => resolveParticipantImage("sha256:old", "rm_x-api:latest", present([]))).toThrow(/neither the running api's image sha256:old nor rm_x-api:latest exists/);
  });
});

import { unseatedTwinMembers } from "../../lib/participant-compose.ts";

describe("unseatedTwinMembers — the twin seats every active restored member (issue #1152)", () => {
  const roster = [
    { id: "a1", handle: "athena", status: "active", role: "member" },
    { id: "z1", handle: "zyfai", status: "active", role: "member" },
    { id: "d1", handle: "DualMint", status: "active", role: "member" },
    { id: "t1", handle: "themis", status: "active", role: "judge" },
    { id: "r1", handle: "retired-one", status: "retired", role: "member" },
    { id: "nohandle", handle: null, status: "active", role: "member" },
  ];
  test("names the active non-judge members the agents roster does not carry, by handle, case-insensitively", () => {
    expect(unseatedTwinMembers(roster, ["Athena", "dualmint"])).toEqual(["nohandle", "zyfai"]);
  });
  test("a full roster leaves nobody unseated; a judge is never a seat", () => {
    expect(unseatedTwinMembers(roster, ["athena", "zyfai", "dualmint", "nohandle"])).toEqual([]);
  });
});
