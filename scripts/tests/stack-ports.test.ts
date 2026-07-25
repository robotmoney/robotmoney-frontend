// Pure unit tests for scripts/stack/ports.ts — no Docker, no network beyond
// binding loopback sockets the test itself releases.
import { describe, expect, test } from "bun:test";
import { allocatePorts, parsePort } from "../stack/ports.ts";

describe("parsePort", () => {
  test("unset or blank means 'draw a random free port'", () => {
    expect(parsePort("WEB_PORT", undefined)).toBeUndefined();
    expect(parsePort("WEB_PORT", "")).toBeUndefined();
    expect(parsePort("WEB_PORT", "  ")).toBeUndefined();
  });

  test("an out-of-range or non-numeric pin throws WITH the knob's name in the message", () => {
    expect(() => parsePort("WEB_PORT", "70000")).toThrow(/WEB_PORT/);
    expect(() => parsePort("WEB_PORT", "abc")).toThrow(/WEB_PORT/);
    expect(() => parsePort("POSTGRES_PORT", "0")).toThrow(/POSTGRES_PORT/);
    expect(() => parsePort("POSTGRES_PORT", "-1")).toThrow(/POSTGRES_PORT/);
  });

  test("a valid pin is honoured as-is", () => {
    expect(parsePort("WEB_PORT", "48787")).toBe(48787);
  });
});

describe("allocatePorts", () => {
  test("an explicit pin comes back untouched, never probed", async () => {
    expect(await allocatePorts([{ fixed: 12345 }])).toEqual([12345]);
  });

  test("a free preferred port is taken", async () => {
    const [probe] = await allocatePorts([{}]);
    expect(await allocatePorts([{ preferred: probe! }])).toEqual([probe]);
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
    const again = await allocatePorts([{ preferred: p! }]);
    expect(again).toEqual([p]);
  });
});
